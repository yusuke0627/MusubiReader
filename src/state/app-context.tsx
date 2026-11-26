import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { openDatabase, type SQLiteDatabaseLike } from '../data/database';
import { ArticleRepository } from '../data/repositories/article-repository';
import { CatalogRepository } from '../data/repositories/catalog-repository';
import {
  DEFAULT_USER_PREFETCH_BATCH_SIZE,
  SettingsRepository,
} from '../data/repositories/settings-repository';
import type { PrefetchCandidateOptions } from '../domain/purge-policy';
import type {
  Article,
  BookmarkFolder,
  CacheEntry,
  CustomFeed,
  InterestKeyword,
  NgWord,
  RemoteCatalog,
  ResolvedFeed,
  UserFeedOverride,
  UserPackSetting,
} from '../domain/types';
import { registerBackgroundTasks } from '../services/background-tasks';
import {
  createTimeoutFetcher,
  getRemoteConfig,
  syncAndCompileAdBlockRules,
  type AdBlockRulesCacheStore,
  type RemoteConfig,
} from '../services/remote-config';
import {
  createExpoFileStore,
  createExpoNetworkStateProvider,
  getArticlePrefetchDir,
  runWifiPrefetchAndPurge,
  type NetworkStateLike,
  type WifiPrefetchAndPurgeResult,
} from '../services/prefetch-service';
import {
  configureNotificationHandler,
  ensureNotificationPermissions,
  syncAllFeeds,
  type SyncAllFeedsResult,
} from '../services/sync-service';

export const FOREGROUND_SYNC_COOLDOWN_MS = 15 * 60 * 1000;

export interface AppRuntimeOverrides {
  db?: SQLiteDatabaseLike;
  catalogRepo?: CatalogRepository;
  articleRepo?: ArticleRepository;
  settingsRepo?: SettingsRepository;
  syncFn?: (signal?: AbortSignal) => Promise<SyncAllFeedsResult>;
  prefetchFn?: (
    options?: PrefetchCandidateOptions & { signal?: AbortSignal }
  ) => Promise<WifiPrefetchAndPurgeResult>;
  registerBackgroundFn?: () => Promise<void>;
  configureNotificationsFn?: () => Promise<void>;
  requestNotificationPermissionsFn?: () => Promise<boolean>;
  subscribeAppState?: (
    listener: (nextState: AppStateStatus) => void
  ) => () => void;
  remoteConfig?: RemoteConfig;
  fetcher?: typeof fetch;
  adBlockCacheStore?: AdBlockRulesCacheStore;
  getNetworkStateFn?: () => Promise<NetworkStateLike>;
  deleteCachePathFn?: (targetPath: string) => Promise<void>;
  now?: () => number;
}

interface ResolvedRuntime {
  catalogRepo: CatalogRepository;
  articleRepo: ArticleRepository;
  settingsRepo: SettingsRepository;
  syncFn: (signal?: AbortSignal) => Promise<SyncAllFeedsResult>;
  prefetchFn: (
    options?: PrefetchCandidateOptions & { signal?: AbortSignal }
  ) => Promise<WifiPrefetchAndPurgeResult>;
  registerBackgroundFn: () => Promise<void>;
  configureNotificationsFn: () => Promise<void>;
  requestNotificationPermissionsFn: () => Promise<boolean>;
  refreshCatalogFn: () => Promise<void>;
  syncAdBlockRulesFn: () => Promise<void>;
  getNetworkStateFn: () => Promise<NetworkStateLike>;
  deleteCachePathFn: (targetPath: string) => Promise<void>;
  now: () => number;
}

export interface AppDataContextValue {
  isReady: boolean;
  initError: string | null;
  catalog: RemoteCatalog | null;
  resolvedFeeds: ResolvedFeed[];
  packSettings: UserPackSetting[];
  feedOverrides: UserFeedOverride[];
  customFeeds: CustomFeed[];
  interestKeywords: InterestKeyword[];
  ngWords: NgWord[];
  bookmarkFolders: BookmarkFolder[];
  cacheEntries: CacheEntry[];
  networkState: NetworkStateLike | null;
  isSyncing: boolean;
  lastSyncResult: SyncAllFeedsResult | null;
  isPrefetching: boolean;
  lastPrefetchResult: WifiPrefetchAndPurgeResult | null;
  prefetchBatchSize: number;
  totalBlockedAds: number;
  dataVersion: number;
  refreshSnapshot: () => Promise<void>;
  refreshNetworkState: () => Promise<void>;
  syncNow: () => Promise<SyncAllFeedsResult | null>;
  prefetchNow: (
    options?: PrefetchCandidateOptions
  ) => Promise<WifiPrefetchAndPurgeResult | null>;
  syncAndPrefetchNow: (
    options?: PrefetchCandidateOptions
  ) => Promise<WifiPrefetchAndPurgeResult | null>;
  cancelSyncAndPrefetch: () => void;
  setPrefetchBatchSize: (count: number) => Promise<void>;
  recordBlockedAds: (delta: number) => Promise<void>;
  clearPrefetchCache: () => Promise<void>;
  listArticlesByPackAndCategory: (
    packId: string,
    category?: string
  ) => Promise<Article[]>;
  listPickupArticles: () => Promise<
    Array<{ article: Article; matchedKeywords: string[] }>
  >;
  listSavedArticles: () => Promise<Article[]>;
  getArticleById: (articleId: string) => Promise<Article | null>;
  getCacheEntry: (articleId: string) => Promise<CacheEntry | null>;
  recordArticleRead: (articleId: string, category: string) => Promise<void>;
  toggleSaved: (articleId: string) => Promise<void>;
  createBookmarkFolder: (name: string) => Promise<BookmarkFolder | null>;
  deleteBookmarkFolder: (folderId: string) => Promise<void>;
  setArticleBookmarkFolder: (
    articleId: string,
    folderId: string | null
  ) => Promise<void>;
  muteSite: (siteId: string, isCustom?: boolean) => Promise<void>;
  unmuteSite: (siteId: string, isCustom?: boolean) => Promise<void>;
  setPackEnabled: (packId: string, enabled: boolean) => Promise<void>;
  addInterestKeyword: (word: string) => Promise<boolean>;
  deleteInterestKeyword: (id: string) => Promise<void>;
  addNgWord: (word: string) => Promise<boolean>;
  deleteNgWord: (id: string) => Promise<void>;
  addCustomFeed: (input: {
    name: string;
    rssUrl: string;
    category?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  deleteCustomFeed: (siteId: string) => Promise<void>;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

function makeRuleId(prefix: string, word: string, nowMs: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${nowMs}-${hash.toString(16)}`;
}

function makeCustomSiteId(rssUrl: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < rssUrl.length; i += 1) {
    hash ^= rssUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `custom-${hash.toString(16).padStart(8, '0')}`;
}

async function buildRuntime(
  overrides?: AppRuntimeOverrides
): Promise<ResolvedRuntime> {
  const db =
    overrides?.catalogRepo && overrides?.articleRepo && overrides?.settingsRepo
      ? null
      : await openDatabase(overrides?.db);

  const catalogRepo =
    overrides?.catalogRepo ?? new CatalogRepository(db!);
  const articleRepo =
    overrides?.articleRepo ?? new ArticleRepository(db!);
  const settingsRepo =
    overrides?.settingsRepo ?? new SettingsRepository(db!);

  const now = overrides?.now ?? Date.now;
  const fetcher = overrides?.fetcher ?? fetch;
  const remoteConfig = overrides?.remoteConfig ?? getRemoteConfig();
  const networkProvider = createExpoNetworkStateProvider();

  return {
    catalogRepo,
    articleRepo,
    settingsRepo,
    syncFn:
      overrides?.syncFn ??
      ((signal?: AbortSignal) =>
        syncAllFeeds({ catalogRepo, articleRepo, settingsRepo, fetcher, now, signal })),
    prefetchFn:
      overrides?.prefetchFn ??
      (async (options?: PrefetchCandidateOptions & { signal?: AbortSignal }) => {
        const maxBatch = await settingsRepo.getPrefetchBatchSize();
        return runWifiPrefetchAndPurge({
          catalogRepo,
          articleRepo,
          settingsRepo,
          fetcher,
          now,
          maxBatch,
          preferredPackId: options?.preferredPackId,
          preferredCategory: options?.preferredCategory,
          signal: options?.signal,
        });
      }),
    registerBackgroundFn:
      overrides?.registerBackgroundFn ?? (() => registerBackgroundTasks()),
    configureNotificationsFn:
      overrides?.configureNotificationsFn ??
      (() => configureNotificationHandler()),
    requestNotificationPermissionsFn:
      overrides?.requestNotificationPermissionsFn ??
      (() => ensureNotificationPermissions()),
    refreshCatalogFn: async () => {
      if (!remoteConfig.catalogUrl) {
        return;
      }
      await catalogRepo
        .refreshFromRemote(remoteConfig.catalogUrl, createTimeoutFetcher(fetcher))
        .catch(() => {});
    },
    syncAdBlockRulesFn: async () => {
      await syncAndCompileAdBlockRules({
        url: remoteConfig.adBlockRulesUrl,
        fetcher,
        cacheStore: overrides?.adBlockCacheStore,
      }).catch(() => {});
    },
    getNetworkStateFn:
      overrides?.getNetworkStateFn ??
      (() => networkProvider.getNetworkStateAsync()),
    deleteCachePathFn:
      overrides?.deleteCachePathFn ??
      (async (articleIdOrPath: string) => {
        const fileStore = await createExpoFileStore();
        const dir = articleIdOrPath.includes('/')
          ? articleIdOrPath
          : getArticlePrefetchDir(fileStore.cacheDirectory, articleIdOrPath);
        await fileStore.deletePath(dir);
      }),
    now,
  };
}

export function AppDataProvider({
  children,
  runtime: runtimeOverrides,
}: {
  children: React.ReactNode;
  runtime?: AppRuntimeOverrides;
}) {
  const runtimeRef = useRef<ResolvedRuntime | null>(null);
  const mountedRef = useRef(true);
  const syncInFlightRef = useRef<Promise<SyncAllFeedsResult | null> | null>(null);
  const prefetchInFlightRef = useRef<Promise<WifiPrefetchAndPurgeResult | null> | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
  const pendingResyncRef = useRef(false);
  const lastSyncAttemptAtRef = useRef<number>(0);
  const appStateRef = useRef<AppStateStatus>(
    (AppState?.currentState as AppStateStatus | undefined) ?? 'active'
  );

  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<RemoteCatalog | null>(null);
  const [resolvedFeeds, setResolvedFeeds] = useState<ResolvedFeed[]>([]);
  const [packSettings, setPackSettings] = useState<UserPackSetting[]>([]);
  const [feedOverrides, setFeedOverrides] = useState<UserFeedOverride[]>([]);
  const [customFeeds, setCustomFeeds] = useState<CustomFeed[]>([]);
  const [interestKeywords, setInterestKeywords] = useState<InterestKeyword[]>(
    []
  );
  const [ngWords, setNgWords] = useState<NgWord[]>([]);
  const [bookmarkFolders, setBookmarkFolders] = useState<BookmarkFolder[]>([]);
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([]);
  const [networkState, setNetworkState] = useState<NetworkStateLike | null>(
    null
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] =
    useState<SyncAllFeedsResult | null>(null);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [lastPrefetchResult, setLastPrefetchResult] =
    useState<WifiPrefetchAndPurgeResult | null>(null);
  const [prefetchBatchSize, setPrefetchBatchSizeState] = useState<number>(
    DEFAULT_USER_PREFETCH_BATCH_SIZE
  );
  const [totalBlockedAds, setTotalBlockedAds] = useState<number>(0);
  const [dataVersion, setDataVersion] = useState(0);

  const loadSnapshot = useCallback(async (rt: ResolvedRuntime) => {
    // Seed/load the effective catalog before concurrent repository reads so first-launch
    // initialization never races `getResolvedFeeds()` on an empty database.
    const effectiveCatalog = await rt.catalogRepo.getEffectiveCatalog();
    const [
      feeds,
      packs,
      overrides,
      custom,
      keywords,
      ngs,
      folders,
      caches,
      batchSize,
      blockedTotal,
    ] = await Promise.all([
      rt.catalogRepo.getResolvedFeeds(),
      rt.settingsRepo.listPackSettings(),
      rt.settingsRepo.listFeedOverrides(),
      rt.settingsRepo.listCustomFeeds(),
      rt.settingsRepo.listInterestKeywords(),
      rt.settingsRepo.listNgWords(),
      rt.articleRepo.listBookmarkFolders(),
      rt.articleRepo.listCacheEntries(),
      rt.settingsRepo.getPrefetchBatchSize(),
      rt.settingsRepo.getTotalBlockedAds(),
    ]);

    if (!mountedRef.current) {
      return;
    }

    setCatalog(effectiveCatalog);
    setResolvedFeeds(feeds);
    setPackSettings(packs);
    setFeedOverrides(overrides);
    setCustomFeeds(custom);
    setInterestKeywords(keywords);
    setNgWords(ngs);
    setBookmarkFolders(folders);
    setCacheEntries(caches);
    setPrefetchBatchSizeState(batchSize);
    setTotalBlockedAds(blockedTotal);
    setDataVersion((v) => v + 1);
  }, []);

  const refreshNetworkState = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt) {
      return;
    }
    try {
      const state = await rt.getNetworkStateFn();
      if (mountedRef.current) {
        setNetworkState(state);
      }
    } catch {
      // Ignore transient network state errors
    }
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt) {
      return;
    }
    await loadSnapshot(rt);
  }, [loadSnapshot]);

  const syncNow = useCallback(async (): Promise<SyncAllFeedsResult | null> => {
    const rt = runtimeRef.current;
    if (!rt) {
      return null;
    }
    if (syncInFlightRef.current) {
      return syncInFlightRef.current;
    }

    lastSyncAttemptAtRef.current = rt.now();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    const task = (async () => {
      if (mountedRef.current) {
        setIsSyncing(true);
      }
      try {
        await rt.refreshCatalogFn();
        if (controller.signal.aborted) {
          return null;
        }
        const result = await rt.syncFn(controller.signal);
        await loadSnapshot(rt);
        if (mountedRef.current && !controller.signal.aborted) {
          setLastSyncResult(result);
        }
        return result;
      } catch {
        return null;
      } finally {
        if (syncAbortRef.current === controller) {
          syncAbortRef.current = null;
        }
        syncInFlightRef.current = null;
        if (mountedRef.current) {
          setIsSyncing(false);
        }
        if (pendingResyncRef.current && mountedRef.current) {
          pendingResyncRef.current = false;
          void syncNow();
        }
      }
    })();

    syncInFlightRef.current = task;
    return task;
  }, [loadSnapshot]);

  const prefetchNow = useCallback(
    async (
      options?: PrefetchCandidateOptions
    ): Promise<WifiPrefetchAndPurgeResult | null> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return null;
      }
      if (prefetchInFlightRef.current) {
        return prefetchInFlightRef.current;
      }

      const controller = new AbortController();
      prefetchAbortRef.current = controller;

      const task = (async () => {
        if (mountedRef.current) {
          setIsPrefetching(true);
        }
        try {
          const result = await rt.prefetchFn({
            ...options,
            signal: controller.signal,
          });
          await loadSnapshot(rt);
          await refreshNetworkState();
          if (mountedRef.current && !controller.signal.aborted) {
            setLastPrefetchResult(result);
          }
          return result;
        } catch {
          return null;
        } finally {
          if (prefetchAbortRef.current === controller) {
            prefetchAbortRef.current = null;
          }
          prefetchInFlightRef.current = null;
          if (mountedRef.current) {
            setIsPrefetching(false);
          }
        }
      })();

      prefetchInFlightRef.current = task;
      return task;
    },
    [loadSnapshot, refreshNetworkState]
  );

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        if (mountedRef.current) {
          setInitError(null);
        }
        const rt = await buildRuntime(runtimeOverrides);
        if (cancelled || !mountedRef.current) {
          return;
        }
        runtimeRef.current = rt;

        // Immediately seed bundled default-packs.json & load local data first so UI renders immediately.
        await loadSnapshot(rt);
        await refreshNetworkState();
        if (cancelled || !mountedRef.current) {
          return;
        }
        setIsReady(true);

        // Configure foreground notifications, pre-compile ad-block rules, register OS background tasks,
        // and trigger non-blocking initial sync.
        void rt.configureNotificationsFn().catch(() => {});
        void rt.syncAdBlockRulesFn().catch(() => {});
        rt.registerBackgroundFn().catch(() => {});
        void (async () => {
          await syncNow();
          await prefetchNow();
        })();
      } catch (err) {
        runtimeRef.current = null;
        if (!cancelled && mountedRef.current) {
          const message =
            err instanceof Error && err.message
              ? err.message
              : 'データベースの初期化に失敗しました';
          setInitError(message);
          setIsReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [
    runtimeOverrides,
    loadSnapshot,
    refreshNetworkState,
    syncNow,
    prefetchNow,
  ]);

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      const resumedToForeground =
        (prevState === 'background' || prevState === 'inactive') &&
        nextState === 'active';
      if (!resumedToForeground) {
        return;
      }

      void refreshNetworkState();

      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      const elapsed = rt.now() - lastSyncAttemptAtRef.current;
      if (elapsed >= FOREGROUND_SYNC_COOLDOWN_MS) {
        void (async () => {
          await syncNow();
          await prefetchNow();
        })();
      }
    };

    if (runtimeOverrides?.subscribeAppState) {
      return runtimeOverrides.subscribeAppState(handleAppStateChange);
    }

    const subscription = AppState?.addEventListener?.(
      'change',
      handleAppStateChange
    );
    return () => {
      subscription?.remove?.();
    };
  }, [runtimeOverrides, refreshNetworkState, syncNow, prefetchNow]);

  const listArticlesByPackAndCategory = useCallback(
    async (packId: string, category?: string): Promise<Article[]> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return [];
      }
      return rt.articleRepo.listByPackAndCategory(packId, category);
    },
    []
  );

  const listPickupArticles = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt) {
      return [];
    }
    return rt.articleRepo.listPickup();
  }, []);

  const listSavedArticles = useCallback(async (): Promise<Article[]> => {
    const rt = runtimeRef.current;
    if (!rt) {
      return [];
    }
    return rt.articleRepo.listSaved();
  }, []);

  const getArticleById = useCallback(
    async (articleId: string): Promise<Article | null> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return null;
      }
      return rt.articleRepo.getById(articleId);
    },
    []
  );

  const getCacheEntry = useCallback(
    async (articleId: string): Promise<CacheEntry | null> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return null;
      }
      return rt.articleRepo.getCacheEntry(articleId);
    },
    []
  );

  const recordArticleRead = useCallback(
    async (articleId: string, category: string): Promise<void> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.articleRepo.recordRead(articleId, category, rt.now());
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const toggleSaved = useCallback(
    async (articleId: string) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.articleRepo.toggleSaved(articleId);
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const createBookmarkFolder = useCallback(
    async (rawName: string): Promise<BookmarkFolder | null> => {
      const rt = runtimeRef.current;
      const name = rawName.trim();
      if (!rt || !name) {
        return null;
      }
      const existing = await rt.articleRepo.listBookmarkFolders();
      const duplicate = existing.find(
        (folder) => folder.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) {
        return duplicate;
      }
      const folder: BookmarkFolder = {
        id: makeRuleId('folder', name, rt.now()),
        name,
        createdAt: rt.now(),
      };
      await rt.articleRepo.upsertBookmarkFolder(folder);
      await loadSnapshot(rt);
      return folder;
    },
    [loadSnapshot]
  );

  const deleteBookmarkFolder = useCallback(
    async (folderId: string): Promise<void> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.articleRepo.deleteBookmarkFolder(folderId);
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const setArticleBookmarkFolder = useCallback(
    async (articleId: string, folderId: string | null): Promise<void> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.articleRepo.setBookmarkFolder(articleId, folderId);
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const muteSite = useCallback(
    async (siteId: string, isCustom = false) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      if (isCustom) {
        await rt.settingsRepo.setCustomFeedMuted(siteId, true);
      } else {
        await rt.settingsRepo.upsertFeedOverride({
          siteId,
          muted: true,
          updatedAt: rt.now(),
        });
      }
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const unmuteSite = useCallback(
    async (siteId: string, isCustom = false) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      if (isCustom) {
        await rt.settingsRepo.setCustomFeedMuted(siteId, false);
      } else {
        await rt.settingsRepo.upsertFeedOverride({
          siteId,
          muted: false,
          updatedAt: rt.now(),
        });
      }
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const setPackEnabled = useCallback(
    async (packId: string, enabled: boolean) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.settingsRepo.upsertPackSetting({
        packId,
        enabled,
        updatedAt: rt.now(),
      });
      await loadSnapshot(rt);
      if (enabled) {
        if (syncInFlightRef.current) {
          pendingResyncRef.current = true;
        } else {
          void syncNow();
        }
      }
    },
    [loadSnapshot, syncNow]
  );

  const addInterestKeyword = useCallback(
    async (word: string): Promise<boolean> => {
      const rt = runtimeRef.current;
      const trimmed = word.trim();
      if (!rt || !trimmed) {
        return false;
      }
      const existing = await rt.settingsRepo.listInterestKeywords();
      if (
        existing.some(
          (item) => item.word.toLowerCase() === trimmed.toLowerCase()
        )
      ) {
        return false;
      }
      const nowMs = rt.now();
      await rt.settingsRepo.upsertInterestKeyword({
        id: makeRuleId('kw', trimmed, nowMs),
        word: trimmed,
        enabled: true,
        createdAt: nowMs,
      });
      await loadSnapshot(rt);
      await rt.requestNotificationPermissionsFn().catch(() => false);
      return true;
    },
    [loadSnapshot]
  );

  const deleteInterestKeyword = useCallback(
    async (id: string) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.settingsRepo.deleteInterestKeyword(id);
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const addNgWord = useCallback(
    async (word: string): Promise<boolean> => {
      const rt = runtimeRef.current;
      const trimmed = word.trim();
      if (!rt || !trimmed) {
        return false;
      }
      const existing = await rt.settingsRepo.listNgWords();
      if (
        existing.some(
          (item) => item.word.toLowerCase() === trimmed.toLowerCase()
        )
      ) {
        return false;
      }
      const nowMs = rt.now();
      await rt.settingsRepo.upsertNgWord({
        id: makeRuleId('ng', trimmed, nowMs),
        word: trimmed,
        enabled: true,
        createdAt: nowMs,
      });
      await loadSnapshot(rt);
      return true;
    },
    [loadSnapshot]
  );

  const deleteNgWord = useCallback(
    async (id: string) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.settingsRepo.deleteNgWord(id);
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const addCustomFeed = useCallback(
    async (input: {
      name: string;
      rssUrl: string;
      category?: string;
    }): Promise<{ ok: boolean; error?: string }> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return { ok: false, error: '初期化中です' };
      }

      const rawUrl = input.rssUrl.trim();
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            ok: false,
            error: 'http:// または https:// のURLを入力してください',
          };
        }
      } catch {
        return {
          ok: false,
          error: '有効なRSSフィードURLを入力してください',
        };
      }

      const normalizedUrl = parsed.toString();
      const siteName = input.name.trim() || parsed.hostname;
      const category = input.category?.trim() || 'マイRSS';

      await rt.settingsRepo.upsertCustomFeed({
        siteId: makeCustomSiteId(normalizedUrl),
        name: siteName,
        rssUrl: normalizedUrl,
        category,
        muted: false,
        createdAt: rt.now(),
      });
      await loadSnapshot(rt);
      if (syncInFlightRef.current) {
        pendingResyncRef.current = true;
      } else {
        void syncNow();
      }
      return { ok: true };
    },
    [loadSnapshot, syncNow]
  );

  const deleteCustomFeed = useCallback(
    async (siteId: string) => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.settingsRepo.deleteCustomFeed(siteId);
      await rt.articleRepo.deleteUnsavedArticlesBySite(siteId);
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const cancelSyncAndPrefetch = useCallback(() => {
    cancelRequestedRef.current = true;
    pendingResyncRef.current = false;
    syncAbortRef.current?.abort();
    prefetchAbortRef.current?.abort();
    if (mountedRef.current) {
      setIsSyncing(false);
      setIsPrefetching(false);
    }
  }, []);

  const syncAndPrefetchNow = useCallback(
    async (
      options?: PrefetchCandidateOptions
    ): Promise<WifiPrefetchAndPurgeResult | null> => {
      cancelRequestedRef.current = false;
      await syncNow();
      if (cancelRequestedRef.current) {
        return null;
      }
      return prefetchNow(options);
    },
    [syncNow, prefetchNow]
  );

  const setPrefetchBatchSize = useCallback(
    async (count: number): Promise<void> => {
      const rt = runtimeRef.current;
      if (!rt) {
        return;
      }
      await rt.settingsRepo.setPrefetchBatchSize(count, rt.now());
      await loadSnapshot(rt);
    },
    [loadSnapshot]
  );

  const recordBlockedAds = useCallback(async (delta: number): Promise<void> => {
    const rt = runtimeRef.current;
    if (!rt || !Number.isFinite(delta) || delta <= 0) {
      return;
    }
    const nextTotal = await rt.settingsRepo.incrementTotalBlockedAds(
      delta,
      rt.now()
    );
    if (mountedRef.current) {
      setTotalBlockedAds(nextTotal);
    }
  }, []);

  const clearPrefetchCache = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt) {
      return;
    }
    const entries = await rt.articleRepo.listCacheEntries();
    for (const entry of entries) {
      try {
        await rt.deleteCachePathFn(entry.articleId);
      } catch {
        // Continue purging DB metadata even if a local file was already gone.
      }
    }
    await rt.articleRepo.applyPurgePlan({
      deleteCacheArticleIds: entries.map((e) => e.articleId),
      deleteMetadataArticleIds: [],
    });
    await loadSnapshot(rt);
  }, [loadSnapshot]);

  const value = useMemo<AppDataContextValue>(
    () => ({
      isReady,
      initError,
      catalog,
      resolvedFeeds,
      packSettings,
      feedOverrides,
      customFeeds,
      interestKeywords,
      ngWords,
      bookmarkFolders,
      cacheEntries,
      networkState,
      isSyncing,
      lastSyncResult,
      isPrefetching,
      lastPrefetchResult,
      prefetchBatchSize,
      totalBlockedAds,
      dataVersion,
      refreshSnapshot,
      refreshNetworkState,
      syncNow,
      prefetchNow,
      syncAndPrefetchNow,
      cancelSyncAndPrefetch,
      setPrefetchBatchSize,
      recordBlockedAds,
      clearPrefetchCache,
      listArticlesByPackAndCategory,
      listPickupArticles,
      listSavedArticles,
      getArticleById,
      getCacheEntry,
      recordArticleRead,
      toggleSaved,
      createBookmarkFolder,
      deleteBookmarkFolder,
      setArticleBookmarkFolder,
      muteSite,
      unmuteSite,
      setPackEnabled,
      addInterestKeyword,
      deleteInterestKeyword,
      addNgWord,
      deleteNgWord,
      addCustomFeed,
      deleteCustomFeed,
    }),
    [
      isReady,
      initError,
      catalog,
      resolvedFeeds,
      packSettings,
      feedOverrides,
      customFeeds,
      interestKeywords,
      ngWords,
      bookmarkFolders,
      cacheEntries,
      networkState,
      isSyncing,
      lastSyncResult,
      isPrefetching,
      lastPrefetchResult,
      prefetchBatchSize,
      totalBlockedAds,
      dataVersion,
      refreshSnapshot,
      refreshNetworkState,
      syncNow,
      prefetchNow,
      syncAndPrefetchNow,
      cancelSyncAndPrefetch,
      setPrefetchBatchSize,
      recordBlockedAds,
      clearPrefetchCache,
      listArticlesByPackAndCategory,
      listPickupArticles,
      listSavedArticles,
      getArticleById,
      getCacheEntry,
      recordArticleRead,
      toggleSaved,
      createBookmarkFolder,
      deleteBookmarkFolder,
      setArticleBookmarkFolder,
      muteSite,
      unmuteSite,
      setPackEnabled,
      addInterestKeyword,
      deleteInterestKeyword,
      addNgWord,
      deleteNgWord,
      addCustomFeed,
      deleteCustomFeed,
    ]
  );

  return (
    <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
  );
}

export function useAppData(): AppDataContextValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) {
    throw new Error('useAppData must be used inside AppDataProvider');
  }
  return ctx;
}
