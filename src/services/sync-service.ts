import type { ArticleRepository } from '../data/repositories/article-repository';
import type { CatalogRepository } from '../data/repositories/catalog-repository';
import type { SettingsRepository } from '../data/repositories/settings-repository';
import { curatePickupArticles } from '../domain/curation';
import { parseFeedBytes } from '../domain/rss-parser';
import type { Article, ResolvedFeed } from '../domain/types';
import {
  DEFAULT_FETCH_CONCURRENCY,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  mapWithConcurrency,
} from './fetch-utils';

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface LocalNotifier {
  notify(payload: NotificationPayload): Promise<void>;
}

export interface SyncServiceDeps {
  catalogRepo: Pick<CatalogRepository, 'getResolvedFeeds'>;
  articleRepo: Pick<ArticleRepository, 'listAllArticles' | 'upsertArticles'>;
  settingsRepo: Pick<
    SettingsRepository,
    'listInterestKeywords' | 'listNgWords' | 'listFeedOverrides' | 'listCustomFeeds'
  >;
  fetcher?: typeof fetch;
  notifier?: LocalNotifier;
  now?: () => number;
  concurrency?: number;
  timeoutMs?: number;
}

export interface SyncAllFeedsResult {
  fetchedFeeds: number;
  failedFeeds: number;
  newArticles: number;
  newKeywordMatches: Article[];
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Builds a deterministic, filesystem-safe article ID from site and item identity
 * so repeated syncs upsert cleanly and prefetch paths never contain unsafe chars.
 */
export function buildArticleId(siteId: string, url: string, title: string): string {
  const safeSite = siteId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'site';
  const key = `${siteId}\0${url || title}`;
  const high = fnv1a32(key, 0x811c9dc5).toString(16).padStart(8, '0');
  const low = fnv1a32(`${key}\0v2`, 0x9e3779b9).toString(16).padStart(8, '0');
  return `${safeSite}-${high}${low}`;
}

export interface NotificationPermissionsLike {
  granted: boolean;
  canAskAgain?: boolean;
  ios?: {
    status?: number;
  };
}

export interface NotificationsModuleLike {
  IosAuthorizationStatus?: {
    PROVISIONAL?: number;
  };
  setNotificationHandler?: (handler: {
    handleNotification: () => Promise<{
      shouldShowBanner: boolean;
      shouldShowList: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }>;
  } | null) => void;
  getPermissionsAsync: () => Promise<NotificationPermissionsLike>;
  requestPermissionsAsync: (permissions?: {
    ios?: {
      allowAlert?: boolean;
      allowBadge?: boolean;
      allowSound?: boolean;
    };
  }) => Promise<NotificationPermissionsLike>;
}

let defaultNotificationHandlerConfigured = false;

function isNotificationPermissionGranted(
  permissions: NotificationPermissionsLike | null | undefined,
  provisionalStatus?: number
): boolean {
  if (!permissions) {
    return false;
  }
  if (permissions.granted) {
    return true;
  }
  return (
    provisionalStatus !== undefined &&
    permissions.ios?.status === provisionalStatus
  );
}

/**
 * Registers the foreground notification presentation handler cleanly.
 * Safely no-ops on web, Jest, or unsupported non-native runtimes.
 */
export async function configureNotificationHandler(
  notificationsApi?: NotificationsModuleLike
): Promise<void> {
  if (!notificationsApi && defaultNotificationHandlerConfigured) {
    return;
  }

  try {
    const api: NotificationsModuleLike =
      notificationsApi ?? (await import('expo-notifications'));
    if (typeof api.setNotificationHandler !== 'function') {
      return;
    }

    api.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    if (!notificationsApi) {
      defaultNotificationHandlerConfigured = true;
    }
  } catch {
    // Safe no-op in non-native or Jest environments.
  }
}

/**
 * Checks notification authorization and requests iOS alert/badge/sound
 * permissions if still undetermined. Returns whether notifications are allowed.
 */
export async function ensureNotificationPermissions(
  notificationsApi?: NotificationsModuleLike
): Promise<boolean> {
  try {
    const api: NotificationsModuleLike =
      notificationsApi ?? (await import('expo-notifications'));
    const provisional = api.IosAuthorizationStatus?.PROVISIONAL;
    const current = await api.getPermissionsAsync();
    if (isNotificationPermissionGranted(current, provisional)) {
      return true;
    }
    if (current.canAskAgain === false) {
      return false;
    }

    const requested = await api.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return isNotificationPermissionGranted(requested, provisional);
  } catch {
    return false;
  }
}

/**
 * Default Expo runtime local notification sender using `expo-notifications`.
 */
export function createExpoNotifier(): LocalNotifier {
  return {
    async notify(payload: NotificationPayload): Promise<void> {
      const Notifications = await import('expo-notifications');
      const permissions = await Notifications.getPermissionsAsync();
      if (
        !isNotificationPermissionGranted(
          permissions,
          Notifications.IosAuthorizationStatus.PROVISIONAL
        )
      ) {
        return;
      }

      await Notifications.scheduleNotificationAsync({
        content: {
          title: payload.title,
          body: payload.body,
          data: payload.data,
          sound: 'default',
        },
        trigger: null,
      });
    },
  };
}

interface FeedFetchOutcome {
  ok: boolean;
  feed: ResolvedFeed;
  items: ReturnType<typeof parseFeedBytes>;
}

async function fetchAndParseFeed(
  feed: ResolvedFeed,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<FeedFetchOutcome> {
  try {
    const response = await fetchWithTimeout(feed.rssUrl, fetcher, timeoutMs);
    if (!response.ok) {
      return { ok: false, feed, items: [] };
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') ?? undefined;
    const items = parseFeedBytes(new Uint8Array(buffer), contentType);
    return { ok: true, feed, items };
  } catch {
    return { ok: false, feed, items: [] };
  }
}

function buildNotificationPayload(
  curatedMatches: ReadonlyArray<{ article: Article; matchedKeywords: string[] }>
): NotificationPayload {
  if (curatedMatches.length === 1) {
    const { article, matchedKeywords } = curatedMatches[0];
    return {
      title: `ピックアップ新着: ${matchedKeywords.join(', ')}`,
      body: `${article.title} (${article.siteName})`,
      data: {
        articleIds: [article.id],
        url: article.url,
        matchedKeywords,
      },
    };
  }

  const allKeywords = Array.from(
    new Set(curatedMatches.flatMap((entry) => entry.matchedKeywords))
  );
  return {
    title: `興味ワードに${curatedMatches.length}件の新着記事`,
    body: `「${curatedMatches[0].article.title}」ほか`,
    data: {
      articleIds: curatedMatches.map((entry) => entry.article.id),
      matchedKeywords: allKeywords,
    },
  };
}

/**
 * Fetches all enabled, unmuted feeds concurrently (default max 4, 10s timeout),
 * persists parsed articles, and fires a local notification only for newly inserted
 * articles matching enabled interest keywords (excluding NG words and muted sites).
 */
export async function syncAllFeeds(
  deps: SyncServiceDeps
): Promise<SyncAllFeedsResult> {
  const fetcher = deps.fetcher ?? fetch;
  const notifier = deps.notifier ?? createExpoNotifier();
  const nowMs = (deps.now ?? Date.now)();
  const concurrency = deps.concurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const [resolvedFeeds, existingArticles, keywords, ngWords, overrides, customFeeds] =
    await Promise.all([
      deps.catalogRepo.getResolvedFeeds(),
      deps.articleRepo.listAllArticles(),
      deps.settingsRepo.listInterestKeywords(),
      deps.settingsRepo.listNgWords(),
      deps.settingsRepo.listFeedOverrides(),
      deps.settingsRepo.listCustomFeeds(),
    ]);

  const existingById = new Map<string, Article>();
  for (const article of existingArticles) {
    existingById.set(article.id, article);
  }

  const mutedSiteIds = new Set<string>();
  for (const feed of resolvedFeeds) {
    if (feed.muted) {
      mutedSiteIds.add(feed.siteId);
    }
  }
  for (const override of overrides) {
    if (override.muted) {
      mutedSiteIds.add(override.siteId);
    }
  }
  for (const custom of customFeeds) {
    if (custom.muted) {
      mutedSiteIds.add(custom.siteId);
    }
  }

  const activeFeeds = resolvedFeeds.filter(
    (feed) => feed.enabled && !feed.muted && !mutedSiteIds.has(feed.siteId)
  );

  const outcomes = await mapWithConcurrency(activeFeeds, concurrency, (feed) =>
    fetchAndParseFeed(feed, fetcher, timeoutMs)
  );

  let fetchedFeeds = 0;
  let failedFeeds = 0;
  const dedupedById = new Map<string, Article>();

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failedFeeds += 1;
      continue;
    }
    fetchedFeeds += 1;

    for (const item of outcome.items) {
      const id = buildArticleId(outcome.feed.siteId, item.url, item.title);
      if (dedupedById.has(id)) {
        continue;
      }

      const existing = existingById.get(id);
      const publishedAt =
        item.publishedAt > 0
          ? item.publishedAt
          : (existing?.publishedAt ?? nowMs);

      dedupedById.set(id, {
        id,
        packId: outcome.feed.packId,
        siteId: outcome.feed.siteId,
        siteName: outcome.feed.name,
        category: outcome.feed.category,
        title: item.title,
        url: item.url,
        summary: item.summary,
        tags: item.categories,
        publishedAt,
        // Preserve initial fetchedAt for existing rows so 14-day metadata TTL is not reset on re-sync.
        fetchedAt: existing?.fetchedAt ?? nowMs,
        isSaved: existing?.isSaved ?? false,
        isRead: existing?.isRead ?? false,
        isPrefetched: existing?.isPrefetched ?? false,
      });
    }
  }

  const allFetchedArticles = Array.from(dedupedById.values());
  const newlyInserted = allFetchedArticles.filter(
    (article) => !existingById.has(article.id)
  );

  if (allFetchedArticles.length > 0) {
    await deps.articleRepo.upsertArticles(allFetchedArticles);
  }

  const curatedNew = curatePickupArticles(
    newlyInserted,
    keywords,
    ngWords,
    mutedSiteIds
  );
  const newKeywordMatches = curatedNew.map((entry) => entry.article);

  if (curatedNew.length > 0) {
    await notifier.notify(buildNotificationPayload(curatedNew));
  }

  return {
    fetchedFeeds,
    failedFeeds,
    newArticles: newlyInserted.length,
    newKeywordMatches,
  };
}
