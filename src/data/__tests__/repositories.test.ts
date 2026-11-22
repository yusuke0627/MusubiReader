import type { SQLiteDatabase as ExpoSQLiteDatabase } from 'expo-sqlite';
import defaultPacks from '../../../assets/catalog/default-packs.json';
import { planPurge, UNREAD_CACHE_TTL_MS, UNREAD_METADATA_TTL_MS } from '../../domain/purge-policy';
import type {
  Article,
  CacheEntry,
  CustomFeed,
  InterestKeyword,
  NgWord,
  RemoteCatalog,
  UserFeedOverride,
  UserPackSetting,
} from '../../domain/types';
import {
  openDatabase,
  runMigrations,
  type SQLiteBindParams,
  type SQLiteBindValue,
  type SQLiteDatabaseLike,
  type SQLiteRunResultLike,
} from '../database';
import { ArticleRepository } from '../repositories/article-repository';
import { CatalogRepository } from '../repositories/catalog-repository';
import { SettingsRepository } from '../repositories/settings-repository';

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

// Compile-time verification that expo-sqlite's SQLiteDatabase satisfies SQLiteDatabaseLike.
const _assertExpoSQLiteCompatible: (db: ExpoSQLiteDatabase) => SQLiteDatabaseLike = (
  db
) => db;
void _assertExpoSQLiteCompatible;

function toNodeBindValue(value: SQLiteBindValue): string | number | bigint | Uint8Array | null {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

function normalizeNodeParams(
  paramsOrFirst?: SQLiteBindParams | SQLiteBindValue,
  rest: SQLiteBindValue[] = []
): { named?: Record<string, string | number | bigint | Uint8Array | null>; positional: Array<string | number | bigint | Uint8Array | null> } {
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
      return rows.map((row: Record<string, unknown>) => Object.assign({}, row) as T);
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
      return row ? (Object.assign({}, row) as T) : null;
    },
    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
      raw.exec('BEGIN IMMEDIATE');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };

  return { adapter, raw };
}

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'art-1',
    packId: 'matome-5ch',
    siteId: 'it-sokuhou',
    siteName: 'IT速報',
    category: 'IT・ガジェット',
    title: 'TypeScript 6.0 リリースまとめ',
    url: 'https://example.com/articles/1',
    summary: '新機能とパフォーマンス改善のまとめ',
    tags: ['TypeScript', '開発'],
    publishedAt: 1_700_000_100_000,
    fetchedAt: 1_700_000_200_000,
    isSaved: false,
    isRead: false,
    isPrefetched: false,
    ...overrides,
  };
}

describe('SQLite schema & migrations', () => {
  test('creates all required tables and article indexes idempotently', async () => {
    const { adapter, raw } = createInMemorySQLiteAdapter();
    try {
      const db = await openDatabase(adapter);
      await runMigrations(db);

      const tables = await db.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      );
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toEqual(
        expect.arrayContaining([
          'remote_packs',
          'remote_feeds',
          'user_pack_settings',
          'user_feed_overrides',
          'custom_feeds',
          'articles',
          'interest_keywords',
          'ng_words',
          'read_history',
          'prefetch_cache',
        ])
      );

      const indexes = await db.getAllAsync<{ name: string; sql: string | null }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'articles'"
      );
      const indexSqls = indexes.map((i) => i.sql ?? '').join('\n');
      expect(indexSqls).toMatch(/pack_id\s*,\s*category\s*,\s*published_at\s+DESC/i);
      expect(indexSqls).toMatch(/is_saved/i);
    } finally {
      raw.close();
    }
  });
});

describe('CatalogRepository', () => {
  test('initial seed falls back to default-packs.json when remote fetch fails or returns invalid JSON', async () => {
    const { adapter: db1Adapter, raw: raw1 } = createInMemorySQLiteAdapter();
    try {
      const db1 = await openDatabase(db1Adapter);
      const repo1 = new CatalogRepository(db1);

      const networkErrorFetcher = (async () => {
        throw new Error('Network offline');
      }) as unknown as typeof fetch;

      const res1 = await repo1.refreshFromRemote(
        'https://catalog.example.com/packs.json',
        networkErrorFetcher
      );
      expect(res1).toEqual({ updated: false, usedFallback: true });
      const catalog1 = await repo1.getEffectiveCatalog();
      expect(catalog1).toEqual(defaultPacks);
    } finally {
      raw1.close();
    }

    const { adapter: db2Adapter, raw: raw2 } = createInMemorySQLiteAdapter();
    try {
      const db2 = await openDatabase(db2Adapter);
      const repo2 = new CatalogRepository(db2);

      const invalidJsonFetcher = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 'broken', packs: null }),
      })) as unknown as typeof fetch;

      const res2 = await repo2.refreshFromRemote(
        'https://catalog.example.com/packs.json',
        invalidJsonFetcher
      );
      expect(res2).toEqual({ updated: false, usedFallback: true });
      const catalog2 = await repo2.getEffectiveCatalog();
      expect(catalog2).toEqual(defaultPacks);

      const syntaxErrorFetcher = (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })) as unknown as typeof fetch;

      const res3 = await repo2.refreshFromRemote(
        'https://catalog.example.com/packs.json',
        syntaxErrorFetcher
      );
      expect(res3).toEqual({ updated: false, usedFallback: true });
    } finally {
      raw2.close();
    }
  });

  test('remote catalog refresh updates rssUrl without losing user_feed_overrides (muted) or custom_feeds', async () => {
    const { adapter, raw } = createInMemorySQLiteAdapter();
    try {
      const db = await openDatabase(adapter);
      const catalogRepo = new CatalogRepository(db);
      const settingsRepo = new SettingsRepository(db);

      // Seed defaults first
      await catalogRepo.getEffectiveCatalog();

      // Configure user mute override, pack toggle, and custom feed
      await settingsRepo.upsertFeedOverride({
        siteId: 'it-sokuhou',
        muted: true,
        updatedAt: 1_000,
      });
      await settingsRepo.upsertPackSetting({
        packId: 'tech-jp',
        enabled: true,
        updatedAt: 1_000,
      });
      await settingsRepo.upsertCustomFeed({
        siteId: 'my-custom-blog',
        name: '個人テックブログ',
        rssUrl: 'https://myblog.example.jp/rss.xml',
        category: '開発',
        muted: false,
        createdAt: 1_500,
      });

      const updatedCatalog: RemoteCatalog = {
        ...defaultPacks,
        updatedAt: '2026-11-22T00:00:00Z',
        packs: defaultPacks.packs.map((pack) =>
          pack.packId === 'matome-5ch'
            ? {
                ...pack,
                feeds: pack.feeds.map((feed) =>
                  feed.siteId === 'it-sokuhou'
                    ? { ...feed, rssUrl: 'https://cdn.example.jp/itsoku/new.rdf' }
                    : feed
                ),
              }
            : pack
        ),
      };

      const okFetcher = (async () => ({
        ok: true,
        status: 200,
        json: async () => updatedCatalog,
      })) as unknown as typeof fetch;

      const refreshResult = await catalogRepo.refreshFromRemote(
        'https://catalog.example.com/packs.json',
        okFetcher
      );
      expect(refreshResult).toEqual({ updated: true, usedFallback: false });

      const resolvedFeeds = await catalogRepo.getResolvedFeeds();
      const itSokuhou = resolvedFeeds.find((f) => f.siteId === 'it-sokuhou');
      expect(itSokuhou).toEqual({
        packId: 'matome-5ch',
        siteId: 'it-sokuhou',
        name: 'IT速報',
        rssUrl: 'https://cdn.example.jp/itsoku/new.rdf',
        category: 'IT・ガジェット',
        enabled: true,
        muted: true,
        isCustom: false,
      });

      const techFeed = resolvedFeeds.find((f) => f.packId === 'tech-jp');
      expect(techFeed?.enabled).toBe(true);

      const customFeed = resolvedFeeds.find((f) => f.siteId === 'my-custom-blog');
      expect(customFeed).toEqual({
        packId: 'my-rss',
        siteId: 'my-custom-blog',
        name: '個人テックブログ',
        rssUrl: 'https://myblog.example.jp/rss.xml',
        category: '開発',
        enabled: true,
        muted: false,
        isCustom: true,
      });

      // Subsequent failed refresh preserves existing remote catalog
      const failingFetcher = (async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })) as unknown as typeof fetch;

      const failedRefresh = await catalogRepo.refreshFromRemote(
        'https://catalog.example.com/packs.json',
        failingFetcher
      );
      expect(failedRefresh).toEqual({ updated: false, usedFallback: true });
      const preservedFeeds = await catalogRepo.getResolvedFeeds();
      expect(preservedFeeds.find((f) => f.siteId === 'it-sokuhou')?.rssUrl).toBe(
        'https://cdn.example.jp/itsoku/new.rdf'
      );
    } finally {
      raw.close();
    }
  });

  test('omits deprecated remote feeds after catalog refresh', async () => {
    const { adapter, raw } = createInMemorySQLiteAdapter();
    try {
      const db = await openDatabase(adapter);
      const catalogRepo = new CatalogRepository(db);

      const catalogWithDeprecated: RemoteCatalog = {
        ...defaultPacks,
        packs: [
          {
            ...defaultPacks.packs[0],
            feeds: defaultPacks.packs[0].feeds.map((f, idx) =>
              idx === 0 ? { ...f, deprecated: true } : f
            ),
          },
        ],
      };

      const okFetcher = (async () => ({
        ok: true,
        status: 200,
        json: async () => catalogWithDeprecated,
      })) as unknown as typeof fetch;

      await catalogRepo.refreshFromRemote(
        'https://catalog.example.com/packs.json',
        okFetcher
      );

      const resolved = await catalogRepo.getResolvedFeeds();
      const deprecatedSiteId = defaultPacks.packs[0].feeds[0].siteId;
      expect(resolved.find((f) => f.siteId === deprecatedSiteId)).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});

describe('ArticleRepository', () => {
  test('toggleSaved protects an article from applyPurgePlan metadata deletion', async () => {
    const { adapter, raw } = createInMemorySQLiteAdapter();
    try {
      const db = await openDatabase(adapter);
      const repo = new ArticleRepository(db);

      const oldFetchedAt = 1_000_000;
      const nowMs = oldFetchedAt + UNREAD_METADATA_TTL_MS + 60_000;

      const savedTarget = makeArticle({
        id: 'art-saved',
        title: '保存したい重要記事',
        fetchedAt: oldFetchedAt,
        publishedAt: oldFetchedAt,
        isSaved: false,
      });
      const expiredTarget = makeArticle({
        id: 'art-expired',
        title: '古い未保存記事',
        url: 'https://example.com/articles/2',
        fetchedAt: oldFetchedAt,
        publishedAt: oldFetchedAt - 1_000,
        isSaved: false,
      });

      await repo.upsertArticles([savedTarget, expiredTarget]);

      const cacheEntries: CacheEntry[] = [
        {
          articleId: 'art-saved',
          localPath: '/cache/art-saved.html',
          sizeBytes: 1_024,
          cachedAt: oldFetchedAt,
          lastAccessedAt: oldFetchedAt,
        },
        {
          articleId: 'art-expired',
          localPath: '/cache/art-expired.html',
          sizeBytes: 2_048,
          cachedAt: nowMs - UNREAD_CACHE_TTL_MS - 1_000,
          lastAccessedAt: oldFetchedAt,
        },
      ];
      for (const entry of cacheEntries) {
        await repo.upsertCacheEntry(entry);
      }

      const newSavedState = await repo.toggleSaved('art-saved');
      expect(newSavedState).toBe(true);

      const savedList = await repo.listSaved();
      expect(savedList.map((a) => a.id)).toEqual(['art-saved']);

      const allArticles = await repo.listAllArticles();
      const plan = planPurge(allArticles, await repo.listCacheEntries(), nowMs);
      expect(plan.deleteMetadataArticleIds).toEqual(['art-expired']);
      expect(plan.deleteCacheArticleIds).toEqual(['art-expired']);

      await repo.applyPurgePlan(plan);

      // Even if a stale plan explicitly attempts to delete a saved article's metadata,
      // applyPurgePlan must still protect is_saved = 1 rows.
      await repo.applyPurgePlan({
        deleteCacheArticleIds: [],
        deleteMetadataArticleIds: ['art-saved'],
      });

      const remainingSaved = await repo.listSaved();
      expect(remainingSaved).toHaveLength(1);
      expect(remainingSaved[0].id).toBe('art-saved');

      const remainingAll = await repo.listAllArticles();
      expect(remainingAll.map((a) => a.id)).toEqual(['art-saved']);
      expect(remainingAll[0].isPrefetched).toBe(true);

      const remainingCache = await repo.listCacheEntries();
      expect(remainingCache.map((c) => c.articleId)).toEqual(['art-saved']);
    } finally {
      raw.close();
    }
  });

  test('listByPackAndCategory, listPickup, recordRead, and upsertArticles flag preservation', async () => {
    const { adapter, raw } = createInMemorySQLiteAdapter();
    try {
      const db = await openDatabase(adapter);
      const articleRepo = new ArticleRepository(db);
      const settingsRepo = new SettingsRepository(db);

      await settingsRepo.upsertInterestKeyword({
        id: 'kw-1',
        word: 'TypeScript',
        enabled: true,
        createdAt: 100,
      });
      await settingsRepo.upsertNgWord({
        id: 'ng-1',
        word: '炎上',
        enabled: true,
        createdAt: 100,
      });
      await settingsRepo.upsertFeedOverride({
        siteId: 'muted-site',
        muted: true,
        updatedAt: 100,
      });

      const a1 = makeArticle({
        id: 'a1',
        packId: 'tech-jp',
        siteId: 'zenn-trend',
        category: '開発・技術',
        title: 'TypeScript 実践ガイド',
        publishedAt: 2_000,
      });
      const a2 = makeArticle({
        id: 'a2',
        packId: 'tech-jp',
        siteId: 'zenn-trend',
        category: '開発・技術',
        title: 'TypeScript 炎上まとめ',
        url: 'https://example.com/2',
        publishedAt: 3_000,
      });
      const a3 = makeArticle({
        id: 'a3',
        packId: 'tech-jp',
        siteId: 'muted-site',
        category: '開発・技術',
        title: 'TypeScript ミュートサイト記事',
        url: 'https://example.com/3',
        publishedAt: 4_000,
      });
      const a4 = makeArticle({
        id: 'a4',
        packId: 'tech-jp',
        siteId: 'publickey',
        category: 'クラウド・インフラ',
        title: 'Kubernetes 最新動向',
        tags: ['Kubernetes'],
        url: 'https://example.com/4',
        publishedAt: 1_000,
      });

      await articleRepo.upsertArticles([a1, a2, a3, a4]);

      const devArticles = await articleRepo.listByPackAndCategory('tech-jp', '開発・技術');
      expect(devArticles.map((a) => a.id)).toEqual(['a1']);

      const allTech = await articleRepo.listByPackAndCategory('tech-jp');
      expect(allTech.map((a) => a.id)).toEqual(['a1', 'a4']);

      const pickup = await articleRepo.listPickup();
      expect(pickup).toHaveLength(1);
      expect(pickup[0].article.id).toBe('a1');
      expect(pickup[0].matchedKeywords).toEqual(['TypeScript']);

      await articleRepo.toggleSaved('a1');
      await articleRepo.recordRead('a1', '開発・技術', 5_000);

      // Re-upserting from RSS with default false flags preserves isSaved & isRead
      await articleRepo.upsertArticles([
        makeArticle({
          ...a1,
          title: 'TypeScript 実践ガイド (更新)',
          isSaved: false,
          isRead: false,
        }),
      ]);

      const afterRefresh = await articleRepo.listSaved();
      expect(afterRefresh).toHaveLength(1);
      expect(afterRefresh[0].title).toBe('TypeScript 実践ガイド (更新)');
      expect(afterRefresh[0].isSaved).toBe(true);
      expect(afterRefresh[0].isRead).toBe(true);

      const history = await articleRepo.listReadHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        articleId: 'a1',
        category: '開発・技術',
        readAt: 5_000,
      });

      // Muted custom feed also blocks articles in listByPackAndCategory
      await settingsRepo.upsertCustomFeed({
        siteId: 'custom-muted',
        name: 'Muted Custom',
        rssUrl: 'https://custom-muted.example.com/rss',
        category: '開発',
        muted: true,
        createdAt: 100,
      });
      await articleRepo.upsertArticles([
        makeArticle({
          id: 'a-custom-muted',
          packId: 'my-rss',
          siteId: 'custom-muted',
          category: '開発',
          title: 'Muted Custom Article',
          tags: [],
        }),
      ]);
      expect(await articleRepo.listByPackAndCategory('my-rss')).toEqual([]);

      await expect(articleRepo.toggleSaved('missing-id')).rejects.toThrow(
        'Article not found: missing-id'
      );
    } finally {
      raw.close();
    }
  });
});

describe('SettingsRepository', () => {
  test('supports CRUD for interest_keywords, ng_words, user_pack_settings, user_feed_overrides, and custom_feeds', async () => {
    const { adapter, raw } = createInMemorySQLiteAdapter();
    try {
      const db = await openDatabase(adapter);
      const repo = new SettingsRepository(db);

      // interest_keywords
      const kw: InterestKeyword = {
        id: 'kw-1',
        word: 'Expo',
        enabled: true,
        createdAt: 100,
      };
      await repo.upsertInterestKeyword(kw);
      expect(await repo.listInterestKeywords()).toEqual([kw]);
      await repo.setInterestKeywordEnabled('kw-1', false);
      expect((await repo.listInterestKeywords())[0].enabled).toBe(false);
      await repo.deleteInterestKeyword('kw-1');
      expect(await repo.listInterestKeywords()).toEqual([]);

      // ng_words
      const ng: NgWord = {
        id: 'ng-1',
        word: 'スパム',
        enabled: true,
        createdAt: 200,
      };
      await repo.upsertNgWord(ng);
      expect(await repo.listNgWords()).toEqual([ng]);
      await repo.setNgWordEnabled('ng-1', false);
      expect((await repo.listNgWords())[0].enabled).toBe(false);
      await repo.deleteNgWord('ng-1');
      expect(await repo.listNgWords()).toEqual([]);

      // user_pack_settings
      const packSetting: UserPackSetting = {
        packId: 'tech-jp',
        enabled: true,
        updatedAt: 300,
      };
      await repo.upsertPackSetting(packSetting);
      expect(await repo.getPackSetting('tech-jp')).toEqual(packSetting);
      expect(await repo.listPackSettings()).toEqual([packSetting]);
      await repo.upsertPackSetting({ packId: 'tech-jp', enabled: false, updatedAt: 400 });
      expect((await repo.getPackSetting('tech-jp'))?.enabled).toBe(false);
      await repo.deletePackSetting('tech-jp');
      expect(await repo.getPackSetting('tech-jp')).toBeNull();

      // user_feed_overrides
      const override: UserFeedOverride = {
        siteId: 'it-sokuhou',
        muted: true,
        updatedAt: 500,
      };
      await repo.upsertFeedOverride(override);
      expect(await repo.getFeedOverride('it-sokuhou')).toEqual(override);
      expect(await repo.listFeedOverrides()).toEqual([override]);
      await repo.deleteFeedOverride('it-sokuhou');
      expect(await repo.getFeedOverride('it-sokuhou')).toBeNull();

      // custom_feeds
      const customFeed: CustomFeed = {
        siteId: 'custom-1',
        name: 'Custom Blog',
        rssUrl: 'https://custom.example.com/rss.xml',
        category: '個人ブログ',
        muted: false,
        createdAt: 600,
      };
      await repo.upsertCustomFeed(customFeed);
      expect(await repo.getCustomFeed('custom-1')).toEqual(customFeed);
      expect(await repo.listCustomFeeds()).toEqual([customFeed]);
      await repo.setCustomFeedMuted('custom-1', true);
      expect((await repo.getCustomFeed('custom-1'))?.muted).toBe(true);
      await repo.deleteCustomFeed('custom-1');
      expect(await repo.getCustomFeed('custom-1')).toBeNull();
    } finally {
      raw.close();
    }
  });
});
