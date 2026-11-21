import iconv from 'iconv-lite';
import { BackgroundTaskResult, BackgroundTaskStatus } from 'expo-background-task';
import { ArticleRepository } from '../../data/repositories/article-repository';
import { CatalogRepository } from '../../data/repositories/catalog-repository';
import { SettingsRepository } from '../../data/repositories/settings-repository';
import {
  runMigrations,
  type SQLiteBindParams,
  type SQLiteBindValue,
  type SQLiteDatabaseLike,
  type SQLiteRunResultLike,
} from '../../data/database';
import {
  UNREAD_CACHE_TTL_MS,
  UNREAD_METADATA_TTL_MS,
} from '../../domain/purge-policy';
import type { Article, RemoteCatalog } from '../../domain/types';
import {
  BACKGROUND_PREFETCH_TASK_NAME,
  BACKGROUND_SYNC_TASK_NAME,
  executeBackgroundPrefetchTask,
  executeBackgroundSyncTask,
  registerBackgroundTasks,
} from '../background-tasks';
import {
  runWifiPrefetchAndPurge,
  type NetworkStateProvider,
  type PrefetchFileStore,
} from '../prefetch-service';
import {
  configureNotificationHandler,
  ensureNotificationPermissions,
  syncAllFeeds,
  type LocalNotifier,
  type NotificationPayload,
} from '../sync-service';

interface NodeSqliteStatement {
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

declare function require(id: string): unknown;

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
};

function toNodeBindValue(
  value: SQLiteBindValue
): string | number | bigint | Uint8Array | null {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

function normalizeNodeParams(
  paramsOrFirst?: SQLiteBindParams | SQLiteBindValue,
  rest: SQLiteBindValue[] = []
): {
  named?: Record<string, string | number | bigint | Uint8Array | null>;
  positional: Array<string | number | bigint | Uint8Array | null>;
} {
  if (paramsOrFirst === undefined) {
    return { positional: [] };
  }
  if (Array.isArray(paramsOrFirst)) {
    return { positional: paramsOrFirst.map(toNodeBindValue) };
  }
  if (
    typeof paramsOrFirst === 'object' &&
    paramsOrFirst !== null &&
    !(paramsOrFirst instanceof Uint8Array)
  ) {
    const named: Record<string, string | number | bigint | Uint8Array | null> = {};
    for (const [k, v] of Object.entries(paramsOrFirst)) {
      named[k] = toNodeBindValue(v);
    }
    return { named, positional: [] };
  }
  return {
    positional: [paramsOrFirst, ...rest].map(toNodeBindValue),
  };
}

function createInMemorySQLiteAdapter(): {
  adapter: SQLiteDatabaseLike;
  raw: NodeSqliteDatabase;
} {
  const raw = new DatabaseSync(':memory:');

  const adapter: SQLiteDatabaseLike = {
    async execAsync(source: string): Promise<void> {
      raw.exec(source);
    },
    async runAsync(
      source: string,
      params?: SQLiteBindParams | SQLiteBindValue,
      ...rest: SQLiteBindValue[]
    ): Promise<SQLiteRunResultLike> {
      const stmt = raw.prepare(source);
      const bound = normalizeNodeParams(params, rest);
      const res = bound.named
        ? stmt.run(bound.named)
        : stmt.run(...bound.positional);
      return {
        changes: Number(res.changes),
        lastInsertRowId: Number(res.lastInsertRowid),
      };
    },
    async getAllAsync<T>(
      source: string,
      params?: SQLiteBindParams | SQLiteBindValue,
      ...rest: SQLiteBindValue[]
    ): Promise<T[]> {
      const stmt = raw.prepare(source);
      const bound = normalizeNodeParams(params, rest);
      const rows = bound.named
        ? stmt.all(bound.named)
        : stmt.all(...bound.positional);
      return rows as T[];
    },
    async getFirstAsync<T>(
      source: string,
      params?: SQLiteBindParams | SQLiteBindValue,
      ...rest: SQLiteBindValue[]
    ): Promise<T | null> {
      const stmt = raw.prepare(source);
      const bound = normalizeNodeParams(params, rest);
      const row = bound.named
        ? stmt.get(bound.named)
        : stmt.get(...bound.positional);
      return (row as T | undefined) ?? null;
    },
    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
      raw.exec('BEGIN IMMEDIATE;');
      try {
        await task();
        raw.exec('COMMIT;');
      } catch (error) {
        raw.exec('ROLLBACK;');
        throw error;
      }
    },
  };

  return { adapter, raw };
}

async function seedCatalog(
  catalogRepo: CatalogRepository,
  catalog: RemoteCatalog
): Promise<void> {
  await catalogRepo.refreshFromRemote('https://catalog.example.com/packs.json', async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function buildRssXml(items: Array<{ title: string; link: string; description?: string; pubDate?: string }>): string {
  const itemXml = items
    .map(
      (item) => `
      <item>
        <title>${item.title}</title>
        <link>${item.link}</link>
        <description>${item.description ?? ''}</description>
        <pubDate>${item.pubDate ?? 'Sat, 21 Nov 2026 10:00:00 GMT'}</pubDate>
      </item>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    ${itemXml}
  </channel>
</rss>`;
}

function createMemoryFileStore(cacheDirectory = 'file:///tmp/cache/'): {
  store: PrefetchFileStore;
  writtenFiles: Map<string, Uint8Array>;
  deletedPaths: string[];
} {
  const writtenFiles = new Map<string, Uint8Array>();
  const deletedPaths: string[] = [];

  const store: PrefetchFileStore = {
    cacheDirectory,
    async writeFile(filePath: string, data: Uint8Array): Promise<number> {
      writtenFiles.set(filePath, data);
      return data.byteLength;
    },
    async deletePath(targetPath: string): Promise<void> {
      deletedPaths.push(targetPath);
      for (const key of Array.from(writtenFiles.keys())) {
        if (key === targetPath || key.startsWith(targetPath)) {
          writtenFiles.delete(key);
        }
      }
    },
  };

  return { store, writtenFiles, deletedPaths };
}

describe('syncAllFeeds', () => {
  let rawDb: NodeSqliteDatabase;
  let catalogRepo: CatalogRepository;
  let articleRepo: ArticleRepository;
  let settingsRepo: SettingsRepository;

  beforeEach(async () => {
    const created = createInMemorySQLiteAdapter();
    rawDb = created.raw;
    await runMigrations(created.adapter);
    catalogRepo = new CatalogRepository(created.adapter);
    articleRepo = new ArticleRepository(created.adapter);
    settingsRepo = new SettingsRepository(created.adapter);
  });

  afterEach(() => {
    rawDb.close();
  });

  test('continues syncing remaining feeds when one feed fails and notifies only newly inserted unblocked keyword matches', async () => {
    const catalog: RemoteCatalog = {
      schemaVersion: 1,
      updatedAt: '2026-11-21T00:00:00Z',
      packs: [
        {
          packId: 'tech',
          name: 'Tech Pack',
          description: 'Tech news',
          defaultEnabled: true,
          feeds: [
            {
              packId: 'tech',
              siteId: 'site-ok-1',
              name: 'Good Tech',
              rssUrl: 'https://feeds.example.com/good1.xml',
              category: 'AI',
              deprecated: false,
            },
            {
              packId: 'tech',
              siteId: 'site-fail',
              name: 'Broken Feed',
              rssUrl: 'https://feeds.example.com/broken.xml',
              category: 'AI',
              deprecated: false,
            },
            {
              packId: 'tech',
              siteId: 'site-muted',
              name: 'Muted Feed',
              rssUrl: 'https://feeds.example.com/muted.xml',
              category: 'AI',
              deprecated: false,
            },
          ],
        },
        {
          packId: 'disabled-pack',
          name: 'Disabled Pack',
          description: 'Disabled',
          defaultEnabled: false,
          feeds: [
            {
              packId: 'disabled-pack',
              siteId: 'site-disabled',
              name: 'Disabled Feed',
              rssUrl: 'https://feeds.example.com/disabled.xml',
              category: 'Other',
              deprecated: false,
            },
          ],
        },
      ],
    };
    await seedCatalog(catalogRepo, catalog);
    await settingsRepo.upsertFeedOverride({
      siteId: 'site-muted',
      muted: true,
      updatedAt: 100,
    });
    await settingsRepo.upsertInterestKeyword({
      id: 'kw-rust',
      word: 'Rust',
      enabled: true,
      createdAt: 100,
    });
    await settingsRepo.upsertNgWord({
      id: 'ng-spam',
      word: '広告PR',
      enabled: true,
      createdAt: 100,
    });

    const requestedUrls: string[] = [];
    const notifications: NotificationPayload[] = [];
    const notifier: LocalNotifier = {
      async notify(payload) {
        notifications.push(payload);
      },
    };

    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);
      if (url.endsWith('/broken.xml')) {
        return new Response('Server Error', { status: 500 });
      }
      if (url.endsWith('/good1.xml')) {
        const xml = buildRssXml([
          {
            title: 'Rust 2.0 がリリースされました',
            link: 'https://good1.example.com/rust-2',
            description: '新機能まとめ',
            pubDate: 'Sat, 21 Nov 2026 11:00:00 GMT',
          },
          {
            title: 'Rust入門【広告PR】',
            link: 'https://good1.example.com/rust-ad',
            description: 'PR記事',
            pubDate: 'Sat, 21 Nov 2026 10:30:00 GMT',
          },
          {
            title: '今日の天気予報',
            link: 'https://good1.example.com/weather',
            description: '晴れ時々曇り',
            pubDate: 'Sat, 21 Nov 2026 10:00:00 GMT',
          },
        ]);
        return new Response(xml, {
          status: 200,
          headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const firstResult = await syncAllFeeds({
      catalogRepo,
      articleRepo,
      settingsRepo,
      fetcher,
      notifier,
      now: () => 1_700_000_000_000,
    });

    expect(requestedUrls).toEqual([
      'https://feeds.example.com/good1.xml',
      'https://feeds.example.com/broken.xml',
    ]);
    expect(firstResult.fetchedFeeds).toBe(1);
    expect(firstResult.failedFeeds).toBe(1);
    expect(firstResult.newArticles).toBe(3);
    expect(firstResult.newKeywordMatches.map((a) => a.title)).toEqual([
      'Rust 2.0 がリリースされました',
    ]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toContain('Rust 2.0 がリリースされました');

    const stored = await articleRepo.listAllArticles();
    expect(stored).toHaveLength(3);

    // Re-syncing the exact same feed items must not re-notify or reset fetchedAt
    const secondResult = await syncAllFeeds({
      catalogRepo,
      articleRepo,
      settingsRepo,
      fetcher,
      notifier,
      now: () => 1_700_000_500_000,
    });

    expect(secondResult.fetchedFeeds).toBe(1);
    expect(secondResult.failedFeeds).toBe(1);
    expect(secondResult.newArticles).toBe(0);
    expect(secondResult.newKeywordMatches).toEqual([]);
    expect(notifications).toHaveLength(1);

    const storedAfterSecondSync = await articleRepo.listAllArticles();
    for (const article of storedAfterSecondSync) {
      expect(article.fetchedAt).toBe(1_700_000_000_000);
    }
  });

  test('enforces fetch concurrency limit and per-request timeout', async () => {
    const feeds = Array.from({ length: 6 }, (_, i) => ({
      packId: 'tech',
      siteId: `site-${i}`,
      name: `Site ${i}`,
      rssUrl: `https://feeds.example.com/${i}.xml`,
      category: 'Tech',
      deprecated: false,
    }));

    await seedCatalog(catalogRepo, {
      schemaVersion: 1,
      updatedAt: '2026-11-21T00:00:00Z',
      packs: [
        {
          packId: 'tech',
          name: 'Tech',
          description: '',
          defaultEnabled: true,
          feeds,
        },
      ],
    });

    let activeRequests = 0;
    let maxConcurrent = 0;

    const fetcher: typeof fetch = async (input, init) => {
      activeRequests += 1;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      const url = typeof input === 'string' ? input : input.toString();

      try {
        if (url.endsWith('/2.xml')) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('Aborted due to timeout'));
            });
          });
        }
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          buildRssXml([
            {
              title: `Article from ${url}`,
              link: `${url}/1`,
            },
          ]),
          { status: 200 }
        );
      } finally {
        activeRequests -= 1;
      }
    };

    const result = await syncAllFeeds({
      catalogRepo,
      articleRepo,
      settingsRepo,
      fetcher,
      notifier: { notify: async () => {} },
      concurrency: 3,
      timeoutMs: 40,
      now: () => 1_700_000_000_000,
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(result.fetchedFeeds).toBe(5);
    expect(result.failedFeeds).toBe(1);
    expect(result.newArticles).toBe(5);
  });

  test('syncs custom feeds, summarizes multiple keyword matches in one notification, and ignores muted custom feeds', async () => {
    await seedCatalog(catalogRepo, {
      schemaVersion: 1,
      updatedAt: '2026-11-21T00:00:00Z',
      packs: [
        {
          packId: 'disabled-remote',
          name: 'Disabled Remote',
          description: '',
          defaultEnabled: false,
          feeds: [],
        },
      ],
    });
    await settingsRepo.upsertCustomFeed({
      siteId: 'custom-active',
      name: 'My Tech Blog',
      rssUrl: 'https://custom.example.com/feed.xml',
      category: 'Tech',
      muted: false,
      createdAt: 100,
    });
    await settingsRepo.upsertCustomFeed({
      siteId: 'custom-muted',
      name: 'Muted Blog',
      rssUrl: 'https://muted-custom.example.com/feed.xml',
      category: 'Tech',
      muted: true,
      createdAt: 100,
    });
    await settingsRepo.upsertInterestKeyword({
      id: 'kw-ts',
      word: 'TypeScript',
      enabled: true,
      createdAt: 100,
    });

    const notifications: NotificationPayload[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://custom.example.com/feed.xml') {
        return new Response(
          buildRssXml([
            {
              title: 'TypeScript 6.0の新機能',
              link: 'https://custom.example.com/ts6',
              pubDate: 'Sat, 21 Nov 2026 12:00:00 GMT',
            },
            {
              title: 'TypeScript型パズル入門',
              link: 'https://custom.example.com/ts-types',
              pubDate: 'Sat, 21 Nov 2026 11:00:00 GMT',
            },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Should not fetch muted feed: ${url}`);
    };

    const result = await syncAllFeeds({
      catalogRepo,
      articleRepo,
      settingsRepo,
      fetcher,
      notifier: {
        async notify(payload) {
          notifications.push(payload);
        },
      },
      now: () => 1_700_000_000_000,
    });

    expect(result.fetchedFeeds).toBe(1);
    expect(result.failedFeeds).toBe(0);
    expect(result.newArticles).toBe(2);
    expect(result.newKeywordMatches).toHaveLength(2);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('興味ワードに2件の新着記事');
    expect(notifications[0].body).toContain('TypeScript 6.0の新機能');
  });
});

describe('runWifiPrefetchAndPurge', () => {
  let rawDb: NodeSqliteDatabase;
  let articleRepo: ArticleRepository;
  let settingsRepo: SettingsRepository;

  beforeEach(async () => {
    const created = createInMemorySQLiteAdapter();
    rawDb = created.raw;
    await runMigrations(created.adapter);
    articleRepo = new ArticleRepository(created.adapter);
    settingsRepo = new SettingsRepository(created.adapter);
  });

  afterEach(() => {
    rawDb.close();
  });

  function makeArticle(overrides: Partial<Article> & { id: string }): Article {
    return {
      packId: 'tech',
      siteId: 'site-1',
      siteName: 'Site 1',
      category: 'Tech',
      title: `Title ${overrides.id}`,
      url: `https://example.com/articles/${overrides.id}`,
      summary: 'summary',
      tags: [],
      publishedAt: 1_700_000_000_000,
      fetchedAt: 1_700_000_000_000,
      isSaved: false,
      isRead: false,
      isPrefetched: false,
      ...overrides,
    };
  }

  test('skips network downloads when networkState.type !== WIFI while still running local purge', async () => {
    const nowMs = 1_700_000_000_000;
    const expiredArticle = makeArticle({
      id: 'art-expired',
      fetchedAt: nowMs - UNREAD_METADATA_TTL_MS - 1_000,
    });
    const freshArticle = makeArticle({
      id: 'art-fresh',
      fetchedAt: nowMs - 1_000,
    });
    await articleRepo.upsertArticles([expiredArticle, freshArticle]);
    await articleRepo.upsertCacheEntry({
      articleId: 'art-expired',
      localPath: 'file:///tmp/cache/musubi-prefetch/art-expired/index.html',
      sizeBytes: 1024,
      cachedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
      lastAccessedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
    });

    const { store, deletedPaths } = createMemoryFileStore();
    await store.writeFile(
      'file:///tmp/cache/musubi-prefetch/art-expired/index.html',
      new Uint8Array([1, 2, 3])
    );

    const networkState: NetworkStateProvider = {
      async getNetworkStateAsync() {
        return { type: 'CELLULAR', isConnected: true };
      },
    };
    const fetchMock = jest.fn(async () => new Response('ok'));
    const fetcher = fetchMock as unknown as typeof fetch;

    const result = await runWifiPrefetchAndPurge({
      articleRepo,
      settingsRepo,
      networkState,
      fileStore: store,
      fetcher,
      now: () => nowMs,
    });

    expect(result).toEqual({
      skippedNotWifi: true,
      prefetchedCount: 0,
      purgedCacheCount: 1,
      purgedMetadataCount: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletedPaths).toContain('file:///tmp/cache/musubi-prefetch/art-expired/');
    expect((await articleRepo.listAllArticles()).map((a) => a.id)).toEqual(['art-fresh']);
  });

  test('on WIFI downloads HTML + up to 5 primary images for prioritized candidates and deletes purged files', async () => {
    const nowMs = 1_700_000_000_000;

    await settingsRepo.upsertInterestKeyword({
      id: 'kw-ai',
      word: 'AI',
      enabled: true,
      createdAt: 100,
    });
    // Record read history so "News" becomes a top-read category
    await articleRepo.recordRead('hist-1', 'News', nowMs - 60_000);
    await articleRepo.recordRead('hist-2', 'News', nowMs - 50_000);

    const matchedArt = makeArticle({
      id: 'art-matched',
      category: 'Other',
      title: 'AI breakthrough',
      url: 'https://example.com/posts/matched.html',
      publishedAt: nowMs - 1_000,
      fetchedAt: nowMs - 1_000,
    });
    const topCatArt = makeArticle({
      id: 'art-topcat',
      category: 'News',
      title: 'Daily headline',
      url: 'https://example.com/posts/topcat.html',
      publishedAt: nowMs - 2_000,
      fetchedAt: nowMs - 2_000,
    });
    const otherArt = makeArticle({
      id: 'art-other',
      category: 'Sports',
      title: 'Sports score',
      url: 'https://example.com/posts/other.html',
      publishedAt: nowMs - 500,
      fetchedAt: nowMs - 500,
    });
    const expiredUnreadArt = makeArticle({
      id: 'art-old',
      category: 'News',
      title: 'Old unread',
      url: 'https://example.com/posts/old.html',
      fetchedAt: nowMs - UNREAD_METADATA_TTL_MS - 10_000,
    });
    const savedOldArt = makeArticle({
      id: 'art-saved',
      category: 'News',
      title: 'Saved old',
      url: 'https://example.com/posts/saved.html',
      fetchedAt: nowMs - UNREAD_METADATA_TTL_MS - 10_000,
      isSaved: true,
    });

    await articleRepo.upsertArticles([
      matchedArt,
      topCatArt,
      otherArt,
      expiredUnreadArt,
      savedOldArt,
    ]);
    await articleRepo.upsertCacheEntry({
      articleId: 'art-old',
      localPath: 'file:///tmp/cache/musubi-prefetch/art-old/index.html',
      sizeBytes: 500,
      cachedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
      lastAccessedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
    });
    await articleRepo.upsertCacheEntry({
      articleId: 'art-saved',
      localPath: 'file:///tmp/cache/musubi-prefetch/art-saved/index.html',
      sizeBytes: 500,
      cachedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
      lastAccessedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
    });

    const { store, writtenFiles, deletedPaths } = createMemoryFileStore();
    await store.writeFile(
      'file:///tmp/cache/musubi-prefetch/art-old/index.html',
      new Uint8Array([9])
    );

    const downloadedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      downloadedUrls.push(url);

      if (url === 'https://example.com/posts/matched.html') {
        // Contains data: URI + 7 images (relative and absolute, plus 1 duplicate) -> only 5 unique HTTP images should be downloaded
        const html = `
          <html><body>
            <img src="data:image/png;base64,AAAA" />
            <img src="/images/1.jpg" />
            <img src="https://cdn.example.com/2.png" />
            <img src="/images/1.jpg" />
            <img data-src="https://cdn.example.com/3.webp" src="data:image/gif;base64,R0lGOD" />
            <img src="https://cdn.example.com/4.gif" />
            <img src="https://cdn.example.com/5.jpg" />
            <img src="https://cdn.example.com/6.jpg" />
            <img src="https://cdn.example.com/7.jpg" />
          </body></html>
        `;
        return new Response(html, { status: 200 });
      }
      if (url === 'https://example.com/posts/topcat.html') {
        return new Response('<html><body><img src="https://cdn.example.com/top.png"></body></html>', {
          status: 200,
        });
      }
      if (url.startsWith('https://example.com/images/') || url.startsWith('https://cdn.example.com/')) {
        return new Response(new Uint8Array([10, 20, 30, 40]), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await runWifiPrefetchAndPurge({
      articleRepo,
      settingsRepo,
      networkState: {
        async getNetworkStateAsync() {
          return { type: 'WIFI', isConnected: true };
        },
      },
      fileStore: store,
      fetcher,
      now: () => nowMs,
    });

    expect(result).toEqual({
      skippedNotWifi: false,
      prefetchedCount: 2,
      purgedCacheCount: 1,
      purgedMetadataCount: 1,
    });

    // Purged expired unread cache, preserved saved cache & metadata
    expect(deletedPaths).toEqual(['file:///tmp/cache/musubi-prefetch/art-old/']);
    const remainingArticles = await articleRepo.listAllArticles();
    expect(remainingArticles.map((a) => a.id)).not.toContain('art-old');
    expect(remainingArticles.map((a) => a.id)).toContain('art-saved');

    // Did not download art-other (neither keyword-matched nor top-category)
    expect(downloadedUrls).not.toContain('https://example.com/posts/other.html');
    // Downloaded only first 5 unique images for art-matched
    expect(downloadedUrls).not.toContain('https://cdn.example.com/6.jpg');
    expect(downloadedUrls).not.toContain('https://cdn.example.com/7.jpg');
    expect(downloadedUrls).toContain('https://example.com/images/1.jpg');
    expect(downloadedUrls).toContain('https://cdn.example.com/5.jpg');

    // Stored under ${cacheDirectory}musubi-prefetch/${articleId}/
    expect(
      writtenFiles.has('file:///tmp/cache/musubi-prefetch/art-matched/index.html')
    ).toBe(true);
    expect(
      writtenFiles.has('file:///tmp/cache/musubi-prefetch/art-topcat/index.html')
    ).toBe(true);

    const cacheEntries = await articleRepo.listCacheEntries();
    const matchedCache = cacheEntries.find((e) => e.articleId === 'art-matched');
    expect(matchedCache).toBeDefined();
    expect(matchedCache?.localPath).toBe(
      'file:///tmp/cache/musubi-prefetch/art-matched/index.html'
    );
    expect(matchedCache?.sizeBytes).toBeGreaterThan(20);
  });

  test('handles HTML download failure without caching and preserves HTML when an image download fails', async () => {
    const nowMs = 1_700_000_000_000;
    await settingsRepo.upsertInterestKeyword({
      id: 'kw-go',
      word: 'Go',
      enabled: true,
      createdAt: 100,
    });

    const partialImgArticle = makeArticle({
      id: 'art-partial',
      title: 'Go concurrency tips',
      url: 'https://example.com/go-tips.html',
      publishedAt: nowMs - 1_000,
      fetchedAt: nowMs - 1_000,
    });
    const failedHtmlArticle = makeArticle({
      id: 'art-html-fail',
      title: 'Go 500 error page',
      url: 'https://example.com/go-fail.html',
      publishedAt: nowMs - 2_000,
      fetchedAt: nowMs - 2_000,
    });
    await articleRepo.upsertArticles([partialImgArticle, failedHtmlArticle]);

    const { store, writtenFiles } = createMemoryFileStore();
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://example.com/go-tips.html') {
        return new Response(
          '<img src="https://cdn.example.com/ok.png"><img src="https://cdn.example.com/missing.png">',
          { status: 200 }
        );
      }
      if (url === 'https://example.com/go-fail.html') {
        return new Response('Upstream error', { status: 502 });
      }
      if (url === 'https://cdn.example.com/ok.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (url === 'https://cdn.example.com/missing.png') {
        return new Response('Not Found', { status: 404 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await runWifiPrefetchAndPurge({
      articleRepo,
      settingsRepo,
      networkState: {
        async getNetworkStateAsync() {
          return { type: 'WIFI', isConnected: true };
        },
      },
      fileStore: store,
      fetcher,
      now: () => nowMs,
    });

    expect(result.prefetchedCount).toBe(1);
    expect(
      writtenFiles.has('file:///tmp/cache/musubi-prefetch/art-partial/index.html')
    ).toBe(true);
    expect(
      writtenFiles.has('file:///tmp/cache/musubi-prefetch/art-partial/img-0.png')
    ).toBe(true);
    expect(
      writtenFiles.has('file:///tmp/cache/musubi-prefetch/art-partial/img-1.png')
    ).toBe(false);
    expect(
      writtenFiles.has('file:///tmp/cache/musubi-prefetch/art-html-fail/index.html')
    ).toBe(false);

    const cacheEntries = await articleRepo.listCacheEntries();
    expect(cacheEntries.map((c) => c.articleId)).toEqual(['art-partial']);

    const partialHtmlBytes = writtenFiles.get(
      'file:///tmp/cache/musubi-prefetch/art-partial/index.html'
    )!;
    const partialHtml = new TextDecoder('utf-8').decode(partialHtmlBytes);
    expect(partialHtml).toContain('src="img-0.png"');
    expect(partialHtml).not.toContain('https://cdn.example.com/ok.png');
    expect(partialHtml).toContain('https://cdn.example.com/missing.png');
  });

  test('rewrites matched img src and lazy attributes to local relative img-* files and normalizes EUC-JP/base HTML to UTF-8', async () => {
    const nowMs = 1_700_000_000_000;
    await settingsRepo.upsertInterestKeyword({
      id: 'kw-rust',
      word: 'Rust',
      enabled: true,
      createdAt: 100,
    });

    const article = makeArticle({
      id: 'art-rewrite',
      title: 'Rust 日本語ガイド',
      url: 'https://example.com/articles/rust.html',
      publishedAt: nowMs - 1_000,
      fetchedAt: nowMs - 1_000,
    });
    await articleRepo.upsertArticles([article]);

    const eucJpHtml = `<!doctype html>
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">
  <base href="https://example.com/articles/">
  <title>Rust 日本語ガイド</title>
</head>
<body>
  <img src="data:image/png;base64,AAAA" />
  <img src="/media/hero.jpg" srcset="https://cdn.example.com/hero-2x.jpg 2x" alt="hero" />
  <img data-src="https://cdn.example.com/lazy1.webp" src="data:image/gif;base64,R0lGOD" />
  <img data-original="https://cdn.example.com/lazy2.png" alt="orig" />
  <img src="/media/hero.jpg" />
  <img src="https://cdn.example.com/4.gif" />
  <img src="https://cdn.example.com/5.jpg" />
  <img src="https://cdn.example.com/6.jpg" />
  <p>日本語テスト記事</p>
</body>
</html>`;
    const eucJpBytes = iconv.encode(eucJpHtml, 'euc-jp');

    const { store, writtenFiles } = createMemoryFileStore();
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://example.com/articles/rust.html') {
        return new Response(new Uint8Array(eucJpBytes), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (
        url.startsWith('https://example.com/media/') ||
        url.startsWith('https://cdn.example.com/')
      ) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await runWifiPrefetchAndPurge({
      articleRepo,
      settingsRepo,
      networkState: {
        async getNetworkStateAsync() {
          return { type: 'WIFI', isConnected: true };
        },
      },
      fileStore: store,
      fetcher,
      now: () => nowMs,
    });

    expect(result.prefetchedCount).toBe(1);
    const savedBytes = writtenFiles.get(
      'file:///tmp/cache/musubi-prefetch/art-rewrite/index.html'
    )!;
    const savedHtml = new TextDecoder('utf-8').decode(savedBytes);

    // UTF-8 decoding + meta charset normalization + base removal
    expect(savedHtml).toContain('日本語テスト記事');
    expect(savedHtml).toMatch(/charset=["']?utf-8/i);
    expect(savedHtml).not.toMatch(/<base\b/i);

    // Local relative image rewrites (up to 5 unique images, duplicates share img-0, lazy attrs promoted to src)
    expect(savedHtml).toContain('<img src="img-0.jpg" alt="hero" />');
    expect(savedHtml).not.toContain('hero-2x.jpg');
    expect(savedHtml).toContain('<img src="img-1.webp" />');
    expect(savedHtml).not.toContain('data-src=');
    expect(savedHtml).toContain('<img src="img-2.png" alt="orig" />');
    expect(savedHtml).not.toContain('data-original=');
    expect(savedHtml).toContain('<img src="img-3.gif" />');
    expect(savedHtml).toContain('<img src="img-4.jpg" />');
    // Duplicate /media/hero.jpg also maps to img-0.jpg
    expect(savedHtml.match(/src="img-0\.jpg"/g)).toHaveLength(2);
    // 6th image & inline data: URI stay untouched
    expect(savedHtml).toContain('src="https://cdn.example.com/6.jpg"');
    expect(savedHtml).toContain('src="data:image/png;base64,AAAA"');
  });
});

describe('background-tasks', () => {
  test('registerBackgroundTasks defines and registers tasks when available and skips when restricted', async () => {
    const definedTasks = new Set<string>();
    const registeredTasks = new Map<string, { minimumInterval?: number }>();

    const taskManager = {
      isTaskDefined: (name: string) => definedTasks.has(name),
      defineTask: (name: string) => {
        definedTasks.add(name);
      },
      isTaskRegisteredAsync: async (name: string) => registeredTasks.has(name),
    };

    const availableBackgroundTask = {
      getStatusAsync: async () => BackgroundTaskStatus.Available,
      registerTaskAsync: async (
        name: string,
        options?: { minimumInterval?: number }
      ) => {
        registeredTasks.set(name, options ?? {});
      },
    };

    await registerBackgroundTasks({
      taskManager,
      backgroundTask: availableBackgroundTask,
    });

    expect(definedTasks.has(BACKGROUND_SYNC_TASK_NAME)).toBe(true);
    expect(definedTasks.has(BACKGROUND_PREFETCH_TASK_NAME)).toBe(true);
    expect(registeredTasks.has(BACKGROUND_SYNC_TASK_NAME)).toBe(true);
    expect(registeredTasks.has(BACKGROUND_PREFETCH_TASK_NAME)).toBe(true);

    // Second call is idempotent
    await registerBackgroundTasks({
      taskManager,
      backgroundTask: availableBackgroundTask,
    });
    expect(registeredTasks.size).toBe(2);

    // Restricted environment skips registration without throwing
    const restrictedRegister = jest.fn(async () => {});
    await registerBackgroundTasks({
      taskManager,
      backgroundTask: {
        getStatusAsync: async () => BackgroundTaskStatus.Restricted,
        registerTaskAsync: restrictedRegister,
      },
    });
    expect(restrictedRegister).not.toHaveBeenCalled();
  });

  test('background task executors return Success or Failed based on runner outcome', async () => {
    await expect(
      executeBackgroundSyncTask(async () => ({
        fetchedFeeds: 1,
        failedFeeds: 0,
        newArticles: 2,
        newKeywordMatches: [],
      }))
    ).resolves.toBe(BackgroundTaskResult.Success);

    await expect(
      executeBackgroundSyncTask(async () => {
        throw new Error('DB locked');
      })
    ).resolves.toBe(BackgroundTaskResult.Failed);

    await expect(
      executeBackgroundPrefetchTask(async () => ({
        skippedNotWifi: false,
        prefetchedCount: 1,
        purgedCacheCount: 0,
        purgedMetadataCount: 0,
      }))
    ).resolves.toBe(BackgroundTaskResult.Success);

    await expect(
      executeBackgroundPrefetchTask(async () => {
        throw new Error('Disk full');
      })
    ).resolves.toBe(BackgroundTaskResult.Failed);
  });
});

describe('notifications setup and permission helpers', () => {
  test('configureNotificationHandler registers foreground banner/sound handler and safely handles errors', async () => {
    const setNotificationHandler = jest.fn();
    await configureNotificationHandler({
      setNotificationHandler,
      getPermissionsAsync: async () => ({ granted: true }),
      requestPermissionsAsync: async () => ({ granted: true }),
    });

    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = setNotificationHandler.mock.calls[0][0];
    expect(typeof handler.handleNotification).toBe('function');
    await expect(handler.handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });

    await expect(
      configureNotificationHandler({
        setNotificationHandler: () => {
          throw new Error('Native module unavailable');
        },
        getPermissionsAsync: async () => ({ granted: false }),
        requestPermissionsAsync: async () => ({ granted: false }),
      })
    ).resolves.toBeUndefined();
  });

  test('ensureNotificationPermissions requests permission only when undetermined and returns safe false on denial or error', async () => {
    // Already granted -> no prompt
    const requestWhenGranted = jest.fn(async () => ({ granted: true }));
    await expect(
      ensureNotificationPermissions({
        IosAuthorizationStatus: { PROVISIONAL: 3 },
        getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
        requestPermissionsAsync: requestWhenGranted,
      })
    ).resolves.toBe(true);
    expect(requestWhenGranted).not.toHaveBeenCalled();

    // iOS provisional -> already allowed
    await expect(
      ensureNotificationPermissions({
        IosAuthorizationStatus: { PROVISIONAL: 3 },
        getPermissionsAsync: async () => ({
          granted: false,
          canAskAgain: true,
          ios: { status: 3 },
        }),
        requestPermissionsAsync: requestWhenGranted,
      })
    ).resolves.toBe(true);
    expect(requestWhenGranted).not.toHaveBeenCalled();

    // Undetermined -> requests iOS alert/badge/sound and resolves true when granted
    const requestWhenUndetermined = jest.fn(async () => ({ granted: true }));
    await expect(
      ensureNotificationPermissions({
        IosAuthorizationStatus: { PROVISIONAL: 3 },
        getPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
        requestPermissionsAsync: requestWhenUndetermined,
      })
    ).resolves.toBe(true);
    expect(requestWhenUndetermined).toHaveBeenCalledWith({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });

    // Denied permanently (canAskAgain: false) -> skips request and returns false
    const requestWhenDenied = jest.fn(async () => ({ granted: true }));
    await expect(
      ensureNotificationPermissions({
        getPermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
        requestPermissionsAsync: requestWhenDenied,
      })
    ).resolves.toBe(false);
    expect(requestWhenDenied).not.toHaveBeenCalled();

    // Native module unavailability -> safe false
    await expect(
      ensureNotificationPermissions({
        getPermissionsAsync: async () => {
          throw new Error('Unavailable in Jest');
        },
        requestPermissionsAsync: requestWhenDenied,
      })
    ).resolves.toBe(false);
  });
});
