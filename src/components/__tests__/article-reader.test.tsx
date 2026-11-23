import React, { act } from 'react';
import { Linking, Share } from 'react-native';
import { createRoot, type TestInstance } from 'test-renderer';
import ArticleReaderScreen from '../../../app/article/[id]';
import { openDatabase, type SQLiteBindParams, type SQLiteBindValue, type SQLiteDatabaseLike } from '../../data/database';
import { ArticleRepository } from '../../data/repositories/article-repository';
import { CatalogRepository } from '../../data/repositories/catalog-repository';
import { SettingsRepository } from '../../data/repositories/settings-repository';
import type { Article } from '../../domain/types';
import { AppDataProvider, type AppRuntimeOverrides } from '../../state/app-context';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mockBack = jest.fn();
const mockPush = jest.fn();
let mockRouteParams: { id?: string | string[] } = { id: 'art-1' };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    push: mockPush,
  }),
  useLocalSearchParams: () => mockRouteParams,
  Stack: Object.assign(
    ({ children }: { children?: React.ReactNode }) => children ?? null,
    { Screen: () => null }
  ),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => ({
    type: 'WIFI',
    isConnected: true,
    isInternetReachable: true,
  })),
}));

const mockCompileAdBlockRules = jest.fn(async (_rulesJson: string) => ({
  compiled: true,
  usedFallback: false,
}));

let capturedWebViewProps: Record<string, unknown> | null = null;

jest.mock('../../../modules/musubi-webview/src', () => {
  const ReactActual = require('react') as typeof import('react');
  const actual = jest.requireActual(
    '../../../modules/musubi-webview/src'
  ) as typeof import('../../../modules/musubi-webview/src');
  return {
    DEFAULT_ADBLOCK_RULES_JSON: actual.DEFAULT_ADBLOCK_RULES_JSON,
    resolveAdBlockRules: actual.resolveAdBlockRules,
    resolveAdBlockRulesJson: actual.resolveAdBlockRulesJson,
    compileAdBlockRules: (rulesJson: string) => mockCompileAdBlockRules(rulesJson),
    isHttpUrl: actual.isHttpUrl,
    MusubiWebView: (props: Record<string, unknown>) => {
      capturedWebViewProps = props;
      return ReactActual.createElement('MusubiWebViewMock', props);
    },
  };
});

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
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

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    url: 'https://example.com/articles/ts6',
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

async function setupHarness() {
  const { db, close } = createInMemoryDb();
  const opened = await openDatabase(db);
  const catalogRepo = new CatalogRepository(opened);
  const articleRepo = new ArticleRepository(opened);
  const settingsRepo = new SettingsRepository(opened);

  const nowMs = 1_700_000_500_000;
  const runtime: AppRuntimeOverrides = {
    db: opened,
    catalogRepo,
    articleRepo,
    settingsRepo,
    now: () => nowMs,
    registerBackgroundFn: async () => {},
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
  };

  return { articleRepo, runtime, close, nowMs };
}

describe('ArticleReaderScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedWebViewProps = null;
    mockRouteParams = { id: 'art-1' };
  });

  test('loads article + prefetched HTML path, compiles ad-block rules, and records read history on open', async () => {
    const { articleRepo, runtime, close, nowMs } = await setupHarness();
    await articleRepo.upsertArticles([makeSampleArticle({ id: 'art-1', isPrefetched: true })]);
    await articleRepo.upsertCacheEntry({
      articleId: 'art-1',
      localPath: 'file:///var/mobile/Caches/musubi-prefetch/art-1/index.html',
      sizeBytes: 4096,
      cachedAt: nowMs - 1000,
      lastAccessedAt: nowMs - 1000,
    });

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });

    await flushEffects();
    await flushEffects();

    expect(mockCompileAdBlockRules).toHaveBeenCalledTimes(1);
    expect(capturedWebViewProps).not.toBeNull();
    expect(capturedWebViewProps?.url).toBe('https://example.com/articles/ts6');
    expect(capturedWebViewProps?.offlineHtmlPath).toBe(
      'file:///var/mobile/Caches/musubi-prefetch/art-1/index.html'
    );
    expect(capturedWebViewProps?.adBlockEnabled).toBe(true);

    const updatedArticle = await articleRepo.getById('art-1');
    expect(updatedArticle?.isRead).toBe(true);

    const history = await articleRepo.listReadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      articleId: 'art-1',
      category: 'IT・ガジェット',
      readAt: nowMs,
    });

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('toggles saved state via toolbar button (後で読む <-> 保存済み)', async () => {
    const { articleRepo, runtime, close } = await setupHarness();
    await articleRepo.upsertArticles([makeSampleArticle({ id: 'art-1', isSaved: false })]);

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });

    await flushEffects();
    await flushEffects();

    const saveBtn = findByTestId(root.container, 'reader-save-button');
    expect(extractAllText(saveBtn)).toContain('ブックマーク');

    await act(async () => {
      pressNode(saveBtn);
    });
    await flushEffects();

    expect(extractAllText(findByTestId(root.container, 'reader-save-button'))).toContain('ブックマーク済み');
    const saved = await articleRepo.getById('art-1');
    expect(saved?.isSaved).toBe(true);

    await act(async () => {
      pressNode(findByTestId(root.container, 'reader-save-button'));
    });
    await flushEffects();

    expect(extractAllText(findByTestId(root.container, 'reader-save-button'))).toContain('☆ ブックマーク');
    const unsaved = await articleRepo.getById('art-1');
    expect(unsaved?.isSaved).toBe(false);

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('displays offline fallback indicator when MusubiWebView reports usedOfflineFallback', async () => {
    const { articleRepo, runtime, close } = await setupHarness();
    await articleRepo.upsertArticles([makeSampleArticle({ id: 'art-1' })]);

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });

    await flushEffects();
    await flushEffects();

    expect(queryByTestId(root.container, 'reader-offline-indicator')).toBeNull();

    const onLoadEnd = capturedWebViewProps?.onLoadEnd as
      | ((event: { nativeEvent: { url: string; success: boolean; usedOfflineFallback: boolean } }) => void)
      | undefined;
    expect(typeof onLoadEnd).toBe('function');

    await act(async () => {
      onLoadEnd?.({
        nativeEvent: {
          url: 'https://example.com/articles/ts6',
          success: true,
          usedOfflineFallback: true,
        },
      });
    });

    const indicator = findByTestId(root.container, 'reader-offline-indicator');
    expect(extractAllText(indicator)).toContain('オフライン');

    await act(async () => {
      onLoadEnd?.({
        nativeEvent: {
          url: 'https://example.com/articles/ts6',
          success: true,
          usedOfflineFallback: false,
        },
      });
    });

    expect(queryByTestId(root.container, 'reader-offline-indicator')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('handles back, share, and open in Safari toolbar actions', async () => {
    const { articleRepo, runtime, close } = await setupHarness();
    await articleRepo.upsertArticles([makeSampleArticle({ id: 'art-1' })]);

    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
    const openUrlSpy = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined);

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });

    await flushEffects();
    await flushEffects();

    await act(async () => {
      pressNode(findByTestId(root.container, 'reader-share-button'));
    });
    await flushEffects();
    expect(shareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/articles/ts6',
      })
    );

    await act(async () => {
      pressNode(findByTestId(root.container, 'reader-safari-button'));
    });
    await flushEffects();
    expect(openUrlSpy).toHaveBeenCalledWith('https://example.com/articles/ts6');

    await act(async () => {
      pressNode(findByTestId(root.container, 'reader-back-button'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);

    shareSpy.mockRestore();
    openUrlSpy.mockRestore();
    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('renders missing-article fallback without recording read history when article is not found', async () => {
    const { articleRepo, runtime, close } = await setupHarness();
    mockRouteParams = { id: 'missing-article-id' };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });

    await flushEffects();
    await flushEffects();

    const missingView = findByTestId(root.container, 'reader-missing-article');
    expect(extractAllText(missingView)).toContain('記事が見つかりませんでした');
    expect(capturedWebViewProps).toBeNull();

    const history = await articleRepo.listReadHistory();
    expect(history).toHaveLength(0);

    await act(async () => {
      pressNode(findByTestId(root.container, 'reader-back-button'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('displays ad-block count banner and accumulates total blocked ads once per article', async () => {
    const { articleRepo, runtime, close } = await setupHarness();
    const article = makeSampleArticle({ id: 'art-adblock' });
    await articleRepo.upsertArticles([article]);
    mockRouteParams = { id: 'art-adblock' };

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();
    await flushEffects();

    const triggerLoadEnd = capturedWebViewProps?.onLoadEnd as
      | ((event: { nativeEvent: Record<string, unknown> }) => void)
      | undefined;

    await act(async () => {
      triggerLoadEnd?.({
        nativeEvent: {
          url: article.url,
          success: true,
          usedOfflineFallback: false,
          durationMs: 120,
          blockedCount: 7,
        },
      });
    });
    await flushEffects();

    const banner = findByTestId(root.container, 'reader-adblock-count-banner');
    expect(extractAllText(banner)).toContain('7件カット');
    expect(await runtime.settingsRepo!.getTotalBlockedAds()).toBe(7);

    // Second onLoadEnd for the same article should not double-count total
    await act(async () => {
      triggerLoadEnd?.({
        nativeEvent: {
          url: article.url,
          success: true,
          usedOfflineFallback: false,
          durationMs: 110,
          blockedCount: 7,
        },
      });
    });
    await flushEffects();
    expect(await runtime.settingsRepo!.getTotalBlockedAds()).toBe(7);

    await act(async () => {
      root.unmount();
    });
    close();
  });

  test('renders single-line status banner and non-wrapping toolbar button labels', async () => {
    const { articleRepo, runtime, close } = await setupHarness();
    await articleRepo.upsertArticles([makeSampleArticle({ id: 'art-1' })]);

    const root = createRoot();
    await act(async () => {
      root.render(
        <AppDataProvider runtime={runtime}>
          <ArticleReaderScreen />
        </AppDataProvider>
      );
    });
    await flushEffects();
    await flushEffects();

    const triggerLoadEnd = capturedWebViewProps?.onLoadEnd as
      | ((event: { nativeEvent: Record<string, unknown> }) => void)
      | undefined;
    await act(async () => {
      triggerLoadEnd?.({
        nativeEvent: {
          url: 'https://example.com/articles/ts6',
          success: true,
          usedOfflineFallback: true,
          durationMs: 1112,
          blockedCount: 95,
        },
      });
    });

    const indicator = findByTestId(root.container, 'reader-offline-indicator');
    const bannerTexts = indicator.queryAll(
      (node) => node.props?.numberOfLines === 1
    );
    expect(bannerTexts.length).toBeGreaterThanOrEqual(2);
    expect(extractAllText(indicator)).toContain('オフライン');
    expect(extractAllText(indicator)).toContain('95件カット');

    for (const testID of [
      'reader-back-button',
      'reader-save-button',
      'reader-share-button',
      'reader-safari-button',
    ]) {
      const btn = findByTestId(root.container, testID);
      const singleLineText = btn.queryAll(
        (node) =>
          node.props?.numberOfLines === 1 &&
          node.props?.adjustsFontSizeToFit === true
      );
      expect(singleLineText.length).toBeGreaterThanOrEqual(1);
    }

    await act(async () => {
      root.unmount();
    });
    close();
  });
});
