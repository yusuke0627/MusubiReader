import React, { act } from 'react';
import { createRoot, type TestInstance } from 'test-renderer';
import { openDatabase, type SQLiteBindParams, type SQLiteBindValue, type SQLiteDatabaseLike } from '../../data/database';
import { ArticleRepository } from '../../data/repositories/article-repository';
import { CatalogRepository } from '../../data/repositories/catalog-repository';
import { SettingsRepository } from '../../data/repositories/settings-repository';
import type { Article } from '../../domain/types';
import HomeScreen from '../../../app/(tabs)/index';
import PickupScreen from '../../../app/(tabs)/pickup';
import BookmarksScreen from '../../../app/(tabs)/bookmarks';
import SourcesScreen from '../../../app/(tabs)/sources';
import {
  AppDataProvider,
  FOREGROUND_SYNC_COOLDOWN_MS,
  type AppRuntimeOverrides,
} from '../../state/app-context';
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
    expect(textWithoutPrefetch).not.toContain('ダウンロード済み');

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
    expect(textWithPrefetch).toContain('ダウンロード済み');

    // One-tap bookmark toggle button works directly without opening menu
    const quickBookmarkBtn = findByTestId(
      root.container,
      'article-bookmark-button-art-1'
    );
    expect(extractAllText(quickBookmarkBtn)).toContain('ブックマーク');
    await act(async () => {
      pressNode(quickBookmarkBtn);
    });
    expect(onToggleSave).toHaveBeenCalledTimes(1);

    // Open explicit labeled action menu (no mystery icons)
    const menuBtn = findByTestId(root.container, 'article-menu-button-art-1');
    expect(extractAllText(menuBtn)).toContain('メニュー');
    await act(async () => {
      pressNode(menuBtn);
    });

    const saveBtn = findByTestId(root.container, 'article-action-save-art-1');
    const muteBtn = findByTestId(root.container, 'article-action-mute-art-1');
    expect(extractAllText(saveBtn)).toContain('ブックマーク');
    expect(extractAllText(muteBtn)).toContain('このサイトを非表示');

    await act(async () => {
      pressNode(saveBtn);
    });
    expect(onToggleSave).toHaveBeenCalledTimes(2);

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

    const configureNotificationsFn = jest.fn(async () => {});
    const requestNotificationPermissionsFn = jest.fn(async () => true);

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
      configureNotificationsFn,
      requestNotificationPermissionsFn,
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
    expect(configureNotificationsFn).toHaveBeenCalledTimes(1);
    expect(requestNotificationPermissionsFn).not.toHaveBeenCalled();

    // Pickup focuses on keyword-matched curation across packs
    let text = extractAllText(root.container);
    expect(text).toContain('TypeScript入門ガイド');
    expect(text).not.toContain('後で読む保存記事タイトル');

    // Adding a keyword updates chips and requests notification permission once
    const input = findByTestId(root.container, 'pickup-keyword-input');
    await act(async () => {
      input.props.onChangeText('Expo');
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'pickup-keyword-add'));
    });
    await flushEffects();
    expect(extractAllText(root.container)).toContain('Expo');
    expect(requestNotificationPermissionsFn).toHaveBeenCalledTimes(1);

    // Duplicate keyword submission should not re-trigger notification permission prompt
    await act(async () => {
      input.props.onChangeText('Expo');
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'pickup-keyword-add'));
    });
    await flushEffects();
    expect(requestNotificationPermissionsFn).toHaveBeenCalledTimes(1);

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
    const syncFn = jest.fn(async () => ({
      fetchedFeeds: 0,
      failedFeeds: 0,
      newArticles: 0,
      newKeywordMatches: [],
    }));
    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      syncFn,
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

    // Toggle Tech pack ON triggers syncFn; toggling OFF does not
    const syncCallsBeforeEnable = syncFn.mock.calls.length;
    await act(async () => {
      toggleSwitchNode(findByTestId(root.container, 'pack-toggle-tech-jp'), true);
    });
    await flushEffects();
    const techSetting = await settingsRepo.getPackSetting('tech-jp');
    expect(techSetting?.enabled).toBe(true);
    expect(syncFn.mock.calls.length).toBe(syncCallsBeforeEnable + 1);

    await act(async () => {
      toggleSwitchNode(findByTestId(root.container, 'pack-toggle-tech-jp'), false);
    });
    await flushEffects();
    expect(syncFn.mock.calls.length).toBe(syncCallsBeforeEnable + 1);

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

    // App info links (Privacy Policy, Support, Version)
    const { Linking } = require('react-native') as typeof import('react-native');
    const openUrlSpy = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined);
    await act(async () => {
      pressNode(findByTestId(root.container, 'open-privacy-policy-button'));
    });
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://yusuke0627.github.io/MusubiReader/privacy.html'
    );
    await act(async () => {
      pressNode(findByTestId(root.container, 'open-support-button'));
    });
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://yusuke0627.github.io/MusubiReader/support.html'
    );
    expect(extractAllText(findByTestId(root.container, 'app-version-text'))).toContain(
      '1.0.0'
    );
    openUrlSpy.mockRestore();

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('AppDataProvider catches startup initialization failure and surfaces an error state instead of staying stuck loading', async () => {
    const { db, close } = createInMemoryDb();
    const catalogRepo = new CatalogRepository(db);
    jest
      .spyOn(catalogRepo, 'getEffectiveCatalog')
      .mockRejectedValueOnce(new Error('SQLite init failed'));

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo: new ArticleRepository(db),
      settingsRepo: new SettingsRepository(db),
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

    const text = extractAllText(root.container);
    expect(text).toContain('データの読み込みに失敗しました');
    expect(text).toContain('SQLite init failed');
    expect(text).not.toContain('記事を読み込み中です…');

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('AppDataProvider refreshes remote catalog and compiles remote ad-block rules at startup when configured, falling back safely on error', async () => {
    const musubiWebViewModule = require('../../../modules/musubi-webview/src') as typeof import('../../../modules/musubi-webview/src');
    const compileSpy = jest.spyOn(musubiWebViewModule, 'compileAdBlockRules');

    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);

    const remoteCatalogJson = {
      schemaVersion: 1,
      updatedAt: '2026-11-22T00:00:00Z',
      packs: [
        {
          packId: 'matome-5ch',
          name: '5chまとめ',
          description: 'Remote refreshed matome pack',
          defaultEnabled: true,
          feeds: [
            {
              packId: 'matome-5ch',
              siteId: 'remote-new-site',
              name: 'リモート追加まとめ',
              rssUrl: 'https://remote.example.com/rss.xml',
              category: 'IT・ガジェット',
              deprecated: false,
            },
          ],
        },
      ],
    };
    const remoteAdBlockJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://remote-ads\\.example\\.jp/' },
        action: { type: 'block' },
      },
    ]);

    const fetchedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);
      if (url === 'https://static.example.com/catalog.json') {
        return new Response(JSON.stringify(remoteCatalogJson), { status: 200 });
      }
      if (url === 'https://static.example.com/adblock.json') {
        return new Response(remoteAdBlockJson, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      remoteConfig: {
        catalogUrl: 'https://static.example.com/catalog.json',
        adBlockRulesUrl: 'https://static.example.com/adblock.json',
      },
      fetcher,
      adBlockCacheStore: {
        read: async () => null,
        write: async () => {},
      },
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
      configureNotificationsFn: async () => {},
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
    await flushEffects();

    expect(fetchedUrls).toContain('https://static.example.com/catalog.json');
    expect(fetchedUrls).toContain('https://static.example.com/adblock.json');
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(compileSpy).toHaveBeenCalledWith(remoteAdBlockJson);

    const refreshedCatalog = await catalogRepo.getEffectiveCatalog();
    expect(refreshedCatalog.updatedAt).toBe('2026-11-22T00:00:00Z');
    expect(refreshedCatalog.packs[0].feeds[0].siteId).toBe('remote-new-site');

    await act(async () => {
      root.unmount();
    });
    close();

    // Error fallback case: failing remote URLs still compile DEFAULT_ADBLOCK_RULES_JSON and keep bundled catalog
    compileSpy.mockClear();
    const { db: db2, close: close2 } = createInMemoryDb();
    await openDatabase(db2);
    const catalogRepo2 = new CatalogRepository(db2);

    const failingRuntime: AppRuntimeOverrides = {
      db: db2,
      catalogRepo: catalogRepo2,
      articleRepo: new ArticleRepository(db2),
      settingsRepo: new SettingsRepository(db2),
      remoteConfig: {
        catalogUrl: 'https://static.example.com/broken-catalog.json',
        adBlockRulesUrl: 'https://static.example.com/broken-adblock.json',
      },
      fetcher: async () => new Response('Server Error', { status: 500 }),
      adBlockCacheStore: {
        read: async () => null,
        write: async () => {},
      },
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
      configureNotificationsFn: async () => {},
    };

    const root2 = createRoot();
    await act(async () => {
      root2.render(
        <AppDataProvider runtime={failingRuntime}>
          <HomeScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();
    await flushEffects();

    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(compileSpy).toHaveBeenCalledWith(musubiWebViewModule.DEFAULT_ADBLOCK_RULES_JSON);
    const fallbackCatalog = await catalogRepo2.getEffectiveCatalog();
    expect(fallbackCatalog.packs.some((p) => p.packId === 'matome-5ch')).toBe(true);

    compileSpy.mockRestore();
    await act(async () => {
      root2.unmount();
    });
    close2();
  });

  test('AppDataProvider auto-syncs and prefetches on foreground resume only after 15m cooldown', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);

    let currentNow = 1_700_000_000_000;
    let appStateListener: ((state: 'active' | 'background' | 'inactive') => void) | null =
      null;
    const syncSpy = jest.fn(async () => ({
      fetchedFeeds: 1,
      failedFeeds: 0,
      newArticles: 0,
      newKeywordMatches: [],
    }));
    const prefetchSpy = jest.fn(async () => ({
      skippedNotWifi: false,
      prefetchedCount: 0,
      purgedCacheCount: 0,
      purgedMetadataCount: 0,
    }));

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo: new CatalogRepository(db),
      articleRepo: new ArticleRepository(db),
      settingsRepo: new SettingsRepository(db),
      syncFn: syncSpy,
      prefetchFn: prefetchSpy,
      registerBackgroundFn: async () => {},
      configureNotificationsFn: async () => {},
      remoteConfig: { catalogUrl: null, adBlockRulesUrl: null },
      now: () => currentNow,
      subscribeAppState: (listener) => {
        appStateListener = listener as (
          state: 'active' | 'background' | 'inactive'
        ) => void;
        return () => {
          appStateListener = null;
        };
      },
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
    await flushEffects();

    // Initial cold-start sync + prefetch ran once
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledTimes(1);

    // Resume after 5 minutes (< 15m cooldown): should NOT re-sync
    currentNow += 5 * 60 * 1000;
    await act(async () => {
      appStateListener?.('background');
      appStateListener?.('active');
    });
    await flushEffects();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledTimes(1);

    // Resume after >= 15 minutes cooldown: should trigger sync -> prefetch
    currentNow += FOREGROUND_SYNC_COOLDOWN_MS;
    await act(async () => {
      appStateListener?.('background');
      appStateListener?.('active');
    });
    await flushEffects();
    await flushEffects();
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(prefetchSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('HomeScreen prefetch CTA triggers sync+prefetch and SourcesScreen updates prefetch batch size', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const settingsRepo = new SettingsRepository(db);
    const syncSpy = jest.fn(async () => ({
      fetchedFeeds: 1,
      failedFeeds: 0,
      newArticles: 0,
      newKeywordMatches: [],
    }));
    const prefetchSpy = jest.fn(async () => ({
      skippedNotWifi: false,
      prefetchedCount: 5,
      purgedCacheCount: 0,
      purgedMetadataCount: 0,
    }));

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo: new CatalogRepository(db),
      articleRepo: new ArticleRepository(db),
      settingsRepo,
      syncFn: syncSpy,
      prefetchFn: prefetchSpy,
      registerBackgroundFn: async () => {},
      configureNotificationsFn: async () => {},
      remoteConfig: { catalogUrl: null, adBlockRulesUrl: null },
    };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <HomeScreen />
          <SourcesScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();
    await flushEffects();

    const initialSyncCalls = syncSpy.mock.calls.length;
    const initialPrefetchCalls = prefetchSpy.mock.calls.length;

    const batch50Btn = findByTestId(
      root.container,
      'prefetch-batch-option-50'
    );
    await act(async () => {
      pressNode(batch50Btn);
    });
    await flushEffects();
    expect(await settingsRepo.getPrefetchBatchSize()).toBe(50);

    const homePrefetchBtn = findByTestId(
      root.container,
      'home-prefetch-button'
    );
    await act(async () => {
      pressNode(homePrefetchBtn);
    });
    await flushEffects();
    await flushEffects();

    expect(syncSpy.mock.calls.length).toBeGreaterThan(initialSyncCalls);
    expect(prefetchSpy.mock.calls.length).toBeGreaterThan(initialPrefetchCalls);

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('BookmarksScreen lists bookmarked articles, filters by query, and removes via one-tap button', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const articleRepo = new ArticleRepository(db);
    const now = 1_700_000_000_000;

    await articleRepo.upsertArticles([
      makeSampleArticle({
        id: 'bm-1',
        title: '保存したいSwift記事',
        siteName: 'Techまとめ',
        isSaved: true,
        publishedAt: now - 1000,
      }),
      makeSampleArticle({
        id: 'bm-2',
        title: '保存したい料理レシピ',
        siteName: 'ライフまとめ',
        isSaved: true,
        publishedAt: now - 2000,
      }),
      makeSampleArticle({
        id: 'bm-unsaved',
        title: '未保存の記事',
        isSaved: false,
        publishedAt: now - 500,
      }),
    ]);

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo: new CatalogRepository(db),
      articleRepo,
      settingsRepo: new SettingsRepository(db),
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
      configureNotificationsFn: async () => {},
      remoteConfig: { catalogUrl: null, adBlockRulesUrl: null },
    };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <BookmarksScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();
    await flushEffects();

    let text = extractAllText(root.container);
    expect(text).toContain('ブックマーク（2件）');
    expect(text).toContain('保存したいSwift記事');
    expect(text).toContain('保存したい料理レシピ');
    expect(text).not.toContain('未保存の記事');

    // Filter by query (case-insensitive NFKC)
    const searchInput = findByTestId(root.container, 'bookmarks-search-input');
    await act(async () => {
      searchInput.props.onChangeText('ｓｗｉｆｔ');
    });
    text = extractAllText(root.container);
    expect(text).toContain('保存したいSwift記事');
    expect(text).not.toContain('保存したい料理レシピ');

    // Clear query and remove bm-1 via one-tap bookmark button
    await act(async () => {
      pressNode(findByTestId(root.container, 'bookmarks-search-clear'));
    });
    await act(async () => {
      pressNode(findByTestId(root.container, 'article-bookmark-button-bm-1'));
    });
    await flushEffects();
    await flushEffects();

    text = extractAllText(root.container);
    expect(text).toContain('ブックマーク（1件）');
    expect(text).not.toContain('保存したいSwift記事');
    expect(text).toContain('保存したい料理レシピ');

    await act(async () => {
      root.unmount();
    });
    await flushEffects();
    close();
  });

  test('HomeScreen toggles downloaded-only filter manually on Wi-Fi and resets from empty state', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);
    await catalogRepo.getEffectiveCatalog();

    await articleRepo.upsertArticles([
      makeSampleArticle({
        id: 'dl-art-1',
        packId: 'matome-5ch',
        title: 'キャッシュ済みの記事タイトル',
      }),
      makeSampleArticle({
        id: 'dl-art-2',
        packId: 'matome-5ch',
        title: '未ダウンロードの記事タイトル',
      }),
    ]);
    await articleRepo.upsertCacheEntry({
      articleId: 'dl-art-1',
      localPath: '/cache/musubi-prefetch/dl-art-1/index.html',
      sizeBytes: 1024,
      cachedAt: 1000,
      lastAccessedAt: 1000,
    });

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      getNetworkStateFn: async () => ({ type: 'WIFI', isConnected: true }),
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
      configureNotificationsFn: async () => {},
      remoteConfig: { catalogUrl: null, adBlockRulesUrl: null },
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
    await flushEffects();

    // On Wi-Fi, filter is OFF by default -> both articles visible
    let text = extractAllText(root.container);
    expect(text).toContain('キャッシュ済みの記事タイトル');
    expect(text).toContain('未ダウンロードの記事タイトル');

    // Toggle downloaded-only filter ON
    await act(async () => {
      pressNode(findByTestId(root.container, 'home-downloaded-filter-button'));
    });
    text = extractAllText(root.container);
    expect(text).toContain('キャッシュ済みの記事タイトル');
    expect(text).not.toContain('未ダウンロードの記事タイトル');

    // Toggle downloaded-only filter OFF
    await act(async () => {
      pressNode(findByTestId(root.container, 'home-downloaded-filter-button'));
    });
    text = extractAllText(root.container);
    expect(text).toContain('キャッシュ済みの記事タイトル');
    expect(text).toContain('未ダウンロードの記事タイトル');

    await act(async () => {
      root.unmount();
    });
    await flushEffects();
    close();
  });

  test('HomeScreen auto-enables downloaded-only filter on cellular when cached articles exist', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);
    await catalogRepo.getEffectiveCatalog();

    await articleRepo.upsertArticles([
      makeSampleArticle({
        id: 'cell-art-1',
        packId: 'matome-5ch',
        title: '携帯回線ですぐ読める記事',
      }),
      makeSampleArticle({
        id: 'cell-art-2',
        packId: 'matome-5ch',
        title: '携帯回線では隠れる未DL記事',
      }),
    ]);
    await articleRepo.upsertCacheEntry({
      articleId: 'cell-art-1',
      localPath: '/cache/musubi-prefetch/cell-art-1/index.html',
      sizeBytes: 1024,
      cachedAt: 1000,
      lastAccessedAt: 1000,
    });

    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      getNetworkStateFn: async () => ({ type: 'CELLULAR', isConnected: true }),
      syncFn: async () => ({
        fetchedFeeds: 0,
        failedFeeds: 0,
        newArticles: 0,
        newKeywordMatches: [],
      }),
      prefetchFn: async () => ({
        skippedNotWifi: true,
        prefetchedCount: 0,
        purgedCacheCount: 0,
        purgedMetadataCount: 0,
      }),
      registerBackgroundFn: async () => {},
      configureNotificationsFn: async () => {},
      remoteConfig: { catalogUrl: null, adBlockRulesUrl: null },
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
    await flushEffects();

    // Auto-enabled on cellular: only downloaded article shown + banner visible
    let text = extractAllText(root.container);
    expect(text).toContain('携帯回線ですぐ読める記事');
    expect(text).not.toContain('携帯回線では隠れる未DL記事');
    expect(
      findByTestId(root.container, 'home-cellular-filter-banner')
    ).toBeDefined();

    // User can manually turn off the filter to see all articles
    await act(async () => {
      pressNode(findByTestId(root.container, 'home-downloaded-filter-button'));
    });
    text = extractAllText(root.container);
    expect(text).toContain('携帯回線ですぐ読める記事');
    expect(text).toContain('携帯回線では隠れる未DL記事');

    await act(async () => {
      root.unmount();
    });
    await flushEffects();
    close();
  });

  test('HomeScreen does not pull down RefreshControl during startup auto-sync, only on manual pull-to-refresh', async () => {
    const { db, close } = createInMemoryDb();
    await openDatabase(db);
    const catalogRepo = new CatalogRepository(db);
    const articleRepo = new ArticleRepository(db);
    const settingsRepo = new SettingsRepository(db);
    await catalogRepo.getEffectiveCatalog();
    await articleRepo.upsertArticles([
      makeSampleArticle({
        id: 'startup-art-1',
        packId: 'matome-5ch',
        title: '起動直後にすぐ読める記事',
      }),
    ]);

    let resolveSync: (() => void) | null = null;
    const runtime: AppRuntimeOverrides = {
      db,
      catalogRepo,
      articleRepo,
      settingsRepo,
      getNetworkStateFn: async () => ({ type: 'WIFI', isConnected: true }),
      syncFn: () =>
        new Promise((resolve) => {
          resolveSync = () =>
            resolve({
              fetchedFeeds: 1,
              failedFeeds: 0,
              newArticles: 0,
              newKeywordMatches: [],
            });
        }),
      prefetchFn: async () => ({
        skippedNotWifi: false,
        prefetchedCount: 0,
        purgedCacheCount: 0,
        purgedMetadataCount: 0,
      }),
      registerBackgroundFn: async () => {},
      configureNotificationsFn: async () => {},
      remoteConfig: { catalogUrl: null, adBlockRulesUrl: null },
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

    try {
      // Background startup sync is in flight: button shows 取得中…, but RefreshControl is NOT refreshing
      expect(
        extractAllText(findByTestId(root.container, 'home-prefetch-button'))
      ).toContain('取得中…');
      const scrollHosts = root.container.queryAll(
        (node) => Boolean(node.props?.refreshControl)
      );
      expect(scrollHosts.length).toBeGreaterThanOrEqual(1);
      const rcElement = scrollHosts[0].props.refreshControl as {
        props: { refreshing: boolean; onRefresh: () => void };
      };
      expect(rcElement.props.refreshing).toBe(false);
    } finally {
      await act(async () => {
        resolveSync?.();
      });
      await flushEffects();
      await act(async () => {
        root.unmount();
      });
      await flushEffects();
      close();
    }
  });
});
