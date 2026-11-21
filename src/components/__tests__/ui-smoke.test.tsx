import React, { act } from 'react';
import { createRoot, type TestInstance } from 'test-renderer';
import { openDatabase, type SQLiteBindParams, type SQLiteBindValue, type SQLiteDatabaseLike } from '../../data/database';
import { ArticleRepository } from '../../data/repositories/article-repository';
import { CatalogRepository } from '../../data/repositories/catalog-repository';
import { SettingsRepository } from '../../data/repositories/settings-repository';
import type { Article } from '../../domain/types';
import HomeScreen from '../../../app/(tabs)/index';
import PickupScreen from '../../../app/(tabs)/pickup';
import SourcesScreen from '../../../app/(tabs)/sources';
import { AppDataProvider, type AppRuntimeOverrides } from '../../state/app-context';
import { ArticleRow } from '../ArticleRow';
import { CategoryBar } from '../CategoryBar';
import { PackSwitcher } from '../PackSwitcher';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    back: jest.fn(),
  }),
  Tabs: Object.assign(
    ({ children }: { children?: React.ReactNode }) => children ?? null,
    { Screen: () => null }
  ),
  Stack: Object.assign(
    ({ children }: { children?: React.ReactNode }) => children ?? null,
    { Screen: () => null }
  ),
  Link: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => ({
    type: 'WIFI',
    isConnected: true,
    isInternetReachable: true,
  })),
}));

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowId?: number | bigint; lastInsertRowid: number | bigint };
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

function toNodeBindValue(value: SQLiteBindValue): string | number | bigint | Uint8Array | null {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

function normalizeParams(
  paramsOrFirst?: SQLiteBindParams | SQLiteBindValue,
  rest: SQLiteBindValue[] = []
): Array<string | number | bigint | Uint8Array | null> {
  if (paramsOrFirst === undefined) {
    return [];
  }
  if (Array.isArray(paramsOrFirst)) {
    return paramsOrFirst.map(toNodeBindValue);
  }
  if (
    typeof paramsOrFirst === 'object' &&
    paramsOrFirst !== null &&
    !(paramsOrFirst instanceof Uint8Array)
  ) {
    return [];
  }
  return [paramsOrFirst, ...rest].map(toNodeBindValue);
}

function createInMemoryDb(): { db: SQLiteDatabaseLike; close: () => void } {
  const raw = new DatabaseSync(':memory:');
  let txDepth = 0;

  const db: SQLiteDatabaseLike = {
    async execAsync(source: string) {
      raw.exec(source);
    },
    async runAsync(source: string, paramsOrFirst?: SQLiteBindParams | SQLiteBindValue, ...rest: SQLiteBindValue[]) {
      const stmt = raw.prepare(source);
      const positional = normalizeParams(paramsOrFirst, rest);
      const result = stmt.run(...positional);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    async getAllAsync<T>(source: string, paramsOrFirst?: SQLiteBindParams | SQLiteBindValue, ...rest: SQLiteBindValue[]) {
      const stmt = raw.prepare(source);
      const positional = normalizeParams(paramsOrFirst, rest);
      return stmt.all(...positional) as T[];
    },
    async getFirstAsync<T>(source: string, paramsOrFirst?: SQLiteBindParams | SQLiteBindValue, ...rest: SQLiteBindValue[]) {
      const stmt = raw.prepare(source);
      const positional = normalizeParams(paramsOrFirst, rest);
      const row = stmt.get(...positional);
      return (row ?? null) as T | null;
    },
    async withTransactionAsync(task: () => Promise<void>) {
      if (txDepth > 0) {
        await task();
        return;
      }
      txDepth += 1;
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
  };

  return { db, close: () => raw.close() };
}

function extractAllText(node: TestInstance): string {
  const parts: string[] = [];
  const visit = (current: TestInstance | string) => {
    if (typeof current === 'string') {
      parts.push(current);
      return;
    }
    for (const child of current.children) {
      visit(child);
    }
  };
  visit(node);
  return parts.join(' ');
}

function findByTestId(root: TestInstance, testID: string): TestInstance {
  const matches = root.queryAll((inst) => inst.props?.testID === testID);
  if (matches.length === 0) {
    throw new Error(`Could not find element with testID="${testID}"`);
  }
  return matches[0];
}

function queryByTestId(root: TestInstance, testID: string): TestInstance | null {
  const matches = root.queryAll((inst) => inst.props?.testID === testID);
  return matches[0] ?? null;
}

function pressNode(node: TestInstance) {
  if (typeof node.props?.onPress === 'function') {
    node.props.onPress();
    return;
  }
  let fiber = node.unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onPress === 'function') {
      fiber.memoizedProps.onPress();
      return;
    }
    fiber = fiber.return;
  }
  throw new Error(`Element testID="${node.props?.testID}" has no onPress handler`);
}

function toggleSwitchNode(node: TestInstance, value: boolean) {
  if (typeof node.props?.onValueChange === 'function') {
    node.props.onValueChange(value);
    return;
  }
  let fiber = node.unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onValueChange === 'function') {
      fiber.memoizedProps.onValueChange(value);
      return;
    }
    fiber = fiber.return;
  }
  throw new Error(`Element testID="${node.props?.testID}" has no onValueChange handler`);
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function makeSampleArticle(overrides: Partial<Article> = {}): Article {
  const now = 1_700_000_000_000;
  return {
    id: 'art-1',
    packId: 'matome-5ch',
    siteId: 'it-sokuhou',
    siteName: 'IT速報',
    category: 'IT・ガジェット',
    title: 'TypeScript 6.0の新機能まとめ',
    url: 'https://example.com/1',
    summary: '型チェックがさらに高速化',
    tags: ['TypeScript'],
    publishedAt: now - 10 * 60 * 1000,
    fetchedAt: now,
    isSaved: false,
    isRead: false,
    isPrefetched: false,
    ...overrides,
  };
}

describe('MusubiReader UI smoke tests', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  test('ArticleRow renders title, site name, relative time, optional prefetched badge, and safe action menu', async () => {
    const now = 1_700_000_000_000;
    const onPress = jest.fn();
    const onToggleSave = jest.fn();
    const onMuteSite = jest.fn();

    const root = createRoot();
    await act(async () => {
      root.render(
        <ArticleRow
          article={makeSampleArticle({ isPrefetched: false })}
          onPress={onPress}
          onToggleSave={onToggleSave}
          onMuteSite={onMuteSite}
          nowMs={now}
        />
      );
    });

    const textWithoutPrefetch = extractAllText(root.container);
    expect(textWithoutPrefetch).toContain('TypeScript 6.0の新機能まとめ');
    expect(textWithoutPrefetch).toContain('IT速報');
    expect(textWithoutPrefetch).toContain('10分前');
    expect(textWithoutPrefetch).not.toContain('先読み済み');

    // Re-render with isPrefetched: true
    await act(async () => {
      root.render(
        <ArticleRow
          article={makeSampleArticle({ isPrefetched: true })}
          onPress={onPress}
          onToggleSave={onToggleSave}
          onMuteSite={onMuteSite}
          nowMs={now}
        />
      );
    });

    const textWithPrefetch = extractAllText(root.container);
    expect(textWithPrefetch).toContain('先読み済み');

    // Open explicit labeled action menu (no mystery icons)
    const menuBtn = findByTestId(root.container, 'article-menu-button-art-1');
    expect(extractAllText(menuBtn)).toContain('メニュー');
    await act(async () => {
      pressNode(menuBtn);
    });

    const saveBtn = findByTestId(root.container, 'article-action-save-art-1');
    const muteBtn = findByTestId(root.container, 'article-action-mute-art-1');
    expect(extractAllText(saveBtn)).toContain('後で読む');
    expect(extractAllText(muteBtn)).toContain('このサイトを非表示');

    await act(async () => {
      pressNode(saveBtn);
    });
    expect(onToggleSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      pressNode(menuBtn);
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'article-action-mute-art-1'));
    });
    expect(onMuteSite).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  test('PackSwitcher and CategoryBar emit selection callbacks', async () => {
    const onSelectPack = jest.fn();
    const onSelectCategory = jest.fn();
    const root = createRoot();

    await act(async () => {
      root.render(
        <>
          <PackSwitcher
            packs={[
              { packId: 'matome-5ch', name: '5chまとめ' },
              { packId: 'tech-jp', name: 'Tech' },
              { packId: 'my-rss', name: 'マイRSS' },
            ]}
            selectedPackId="matome-5ch"
            onSelectPack={onSelectPack}
          />
          <CategoryBar
            categories={['すべて', 'IT・ガジェット', 'ニュース・雑談']}
            selectedCategory="すべて"
            onSelectCategory={onSelectCategory}
          />
        </>
      );
    });

    await act(async () => {
      pressNode(findByTestId(root.container, 'pack-tab-tech-jp'));
      pressNode(findByTestId(root.container, 'category-tab-IT・ガジェット'));
    });

    expect(onSelectPack).toHaveBeenCalledWith('tech-jp');
    expect(onSelectCategory).toHaveBeenCalledWith('IT・ガジェット');

    await act(async () => {
      root.unmount();
    });
  });

  test('HomeScreen loads bundled matome-5ch pack immediately and updates categories & articles when switching packs', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);

    // Enable tech-jp pack as well so Home shows both 5chまとめ and Tech
    await settingsRepo.upsertPackSetting({
      packId: 'tech-jp',
      enabled: true,
      updatedAt: Date.now(),
    });

    await articleRepo.upsertArticles([
      makeSampleArticle({
        id: 'art-5ch-1',
        packId: 'matome-5ch',
        siteId: 'it-sokuhou',
        siteName: 'IT速報',
        category: 'IT・ガジェット',
        title: '5chまとめの最新ガジェット記事',
      }),
      makeSampleArticle({
        id: 'art-5ch-2',
        packId: 'matome-5ch',
        siteId: 'alfalfa',
        siteName: 'アルファルファモザイク',
        category: 'ニュース・雑談',
        title: 'ニュース雑談スレッドまとめ',
      }),
      makeSampleArticle({
        id: 'art-tech-1',
        packId: 'tech-jp',
        siteId: 'zenn-trend',
        siteName: 'Zenn トレンド',
        category: '開発・技術',
        title: 'ZennのExpo Router解説記事',
      }),
    ]);

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      syncFn: async () => ({
        fetchedFeeds: 0,
        failedFeeds: 0,
        newArticles: 0,
        newKeywordMatches: [],
      }),
      prefetchFn: async () => ({
        skippedNotWifi: false,
        prefetchedCount: 0,
        purgedCacheCount: 0,
        purgedMetadataCount: 0,
      }),
      registerBackgroundFn: async () => {},
    };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <HomeScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();

    // Initially displays matome-5ch pack categories & both matome articles
    let text = extractAllText(root.container);
    expect(text).toContain('5chまとめ');
    expect(text).toContain('IT・ガジェット');
    expect(text).toContain('5chまとめの最新ガジェット記事');
    expect(text).toContain('ニュース雑談スレッドまとめ');
    expect(text).not.toContain('ZennのExpo Router解説記事');

    // Filter by category IT・ガジェット
    await act(async () => {
      pressNode(findByTestId(root.container, 'category-tab-IT・ガジェット'));
    });
    await flushEffects();
    text = extractAllText(root.container);
    expect(text).toContain('5chまとめの最新ガジェット記事');
    expect(text).not.toContain('ニュース雑談スレッドまとめ');

    // Mute site via safe action menu removes its article immediately
    await act(async () => {
      pressNode(findByTestId(root.container, 'article-menu-button-art-5ch-1'));
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'article-action-mute-art-5ch-1'));
    });
    await flushEffects();
    expect(extractAllText(root.container)).not.toContain(
      '5chまとめの最新ガジェット記事'
    );

    // Switch to tech-jp pack
    await act(async () => {
      pressNode(findByTestId(root.container, 'pack-tab-tech-jp'));
    });
    await flushEffects();

    text = extractAllText(root.container);
    expect(text).toContain('開発・技術');
    expect(text).toContain('ZennのExpo Router解説記事');
    expect(text).not.toContain('5chまとめの最新ガジェット記事');

    // Tapping article navigates to /article/[id]
    await act(async () => {
      pressNode(findByTestId(root.container, 'article-row-art-tech-1'));
    });
    expect(mockPush).toHaveBeenCalledWith('/article/art-tech-1');

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('PickupScreen toggles between キーワード一致 and 保存済み and supports adding keywords', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);

    await settingsRepo.upsertInterestKeyword({
      id: 'kw-1',
      word: 'TypeScript',
      enabled: true,
      createdAt: 1000,
    });

    await articleRepo.upsertArticles([
      makeSampleArticle({
        id: 'art-match',
        title: 'TypeScript入門ガイド',
        isSaved: false,
      }),
      makeSampleArticle({
        id: 'art-saved',
        title: '後で読む保存記事タイトル',
        tags: [],
        summary: 'キーワードとは無関係な記事',
        isSaved: true,
      }),
    ]);

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      syncFn: async () => ({
        fetchedFeeds: 0,
        failedFeeds: 0,
        newArticles: 0,
        newKeywordMatches: [],
      }),
      prefetchFn: async () => ({
        skippedNotWifi: false,
        prefetchedCount: 0,
        purgedCacheCount: 0,
        purgedMetadataCount: 0,
      }),
      registerBackgroundFn: async () => {},
    };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <PickupScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();

    // Default segment: キーワード一致
    let text = extractAllText(root.container);
    expect(text).toContain('キーワード一致');
    expect(text).toContain('保存済み');
    expect(text).toContain('TypeScript入門ガイド');
    expect(text).not.toContain('後で読む保存記事タイトル');

    // Switch segment to 保存済み
    await act(async () => {
      pressNode(findByTestId(root.container, 'pickup-segment-saved'));
    });
    await flushEffects();

    text = extractAllText(root.container);
    expect(text).toContain('後で読む保存記事タイトル');
    expect(text).not.toContain('TypeScript入門ガイド');

    // Switch back to キーワード一致 and verify adding a keyword updates chips
    await act(async () => {
      pressNode(findByTestId(root.container, 'pickup-segment-matched'));
    });
    await flushEffects();
    const input = findByTestId(root.container, 'pickup-keyword-input');
    await act(async () => {
      input.props.onChangeText('Expo');
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'pickup-keyword-add'));
    });
    await flushEffects();
    expect(extractAllText(root.container)).toContain('Expo');

    // Delete existing keyword kw-1
    await act(async () => {
      pressNode(findByTestId(root.container, 'pickup-keyword-delete-kw-1'));
    });
    await flushEffects();
    expect(extractAllText(root.container)).not.toContain('TypeScript入門ガイド');

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('SourcesScreen toggles packs, adds custom RSS, unmutes sites, and clears prefetch cache', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);

    await settingsRepo.upsertFeedOverride({
      siteId: 'alfalfa',
      muted: true,
      updatedAt: 1000,
    });
    await articleRepo.upsertArticles([makeSampleArticle({ id: 'art-cached' })]);
    await articleRepo.upsertCacheEntry({
      articleId: 'art-cached',
      localPath: '/cache/musubi-prefetch/art-cached/index.html',
      sizeBytes: 2048,
      cachedAt: 1000,
      lastAccessedAt: 1000,
    });

    const deletedPaths: string[] = [];
    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      syncFn: async () => ({
        fetchedFeeds: 0,
        failedFeeds: 0,
        newArticles: 0,
        newKeywordMatches: [],
      }),
      prefetchFn: async () => ({
        skippedNotWifi: false,
        prefetchedCount: 0,
        purgedCacheCount: 0,
        purgedMetadataCount: 0,
      }),
      registerBackgroundFn: async () => {},
      deleteCachePathFn: async (path: string) => {
        deletedPaths.push(path);
      },
    };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <SourcesScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();

    const text = extractAllText(root.container);
    expect(text).toContain('5chまとめ');
    expect(text).toContain('Tech');
    expect(text).toContain('アルファルファモザイク');

    // Toggle Tech pack ON
    await act(async () => {
      toggleSwitchNode(findByTestId(root.container, 'pack-toggle-tech-jp'), true);
    });
    await flushEffects();
    const techSetting = await settingsRepo.getPackSetting('tech-jp');
    expect(techSetting?.enabled).toBe(true);

    // Invalid RSS URL shows validation error and does not persist
    await act(async () => {
      findByTestId(root.container, 'custom-rss-url-input').props.onChangeText(
        'not-a-valid-url'
      );
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'custom-rss-add-button'));
    });
    await flushEffects();
    expect(extractAllText(root.container)).toContain('有効なRSSフィードURL');
    expect(await settingsRepo.listCustomFeeds()).toHaveLength(0);

    // Add valid custom RSS URL
    await act(async () => {
      findByTestId(root.container, 'custom-rss-url-input').props.onChangeText(
        'https://example.com/custom-feed.xml'
      );
      findByTestId(root.container, 'custom-rss-name-input').props.onChangeText(
        'サンプルテックブログ'
      );
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'custom-rss-add-button'));
    });
    await flushEffects();
    const customFeeds = await settingsRepo.listCustomFeeds();
    expect(customFeeds.some((f) => f.name === 'サンプルテックブログ')).toBe(true);

    // Add & delete NG word
    await act(async () => {
      findByTestId(root.container, 'ng-word-input').props.onChangeText('ネタバレ');
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'ng-word-add-button'));
    });
    await flushEffects();
    const ngList = await settingsRepo.listNgWords();
    expect(ngList.some((n) => n.word === 'ネタバレ')).toBe(true);
    await act(async () => {
      pressNode(findByTestId(root.container, `delete-ng-word-${ngList[0].id}`));
    });
    await flushEffects();
    expect(await settingsRepo.listNgWords()).toHaveLength(0);

    // Unmute site
    await act(async () => {
      pressNode(findByTestId(root.container, 'unmute-site-alfalfa'));
    });
    await flushEffects();
    const override = await settingsRepo.getFeedOverride('alfalfa');
    expect(override?.muted).toBe(false);

    // Clear prefetch cache
    await act(async () => {
      pressNode(findByTestId(root.container, 'clear-cache-button'));
    });
    await flushEffects();
    expect(await articleRepo.listCacheEntries()).toHaveLength(0);
    expect(deletedPaths.length).toBeGreaterThan(0);

    await act(async () => {
      root.unmount();
    });
    close();
  });
});
