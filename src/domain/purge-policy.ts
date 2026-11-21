import type { Article, CacheEntry, ReadHistoryEntry } from './types';

export const UNREAD_CACHE_TTL_MS = 72 * 60 * 60 * 1000;
export const UNREAD_METADATA_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const UNREAD_CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const SAVED_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const TOP_CATEGORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const TOP_CATEGORY_LIMIT = 3;

interface CategoryStats {
  count: number;
  latestReadAt: number;
}

function compareLexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ranks categories by read count within the trailing 14-day window
 * (`TOP_CATEGORY_WINDOW_MS`) and returns up to `limit` category names.
 */
export function getTopReadCategories(
  history: ReadHistoryEntry[],
  nowMs: number,
  limit: number = TOP_CATEGORY_LIMIT
): string[] {
  const maxCategories = Math.floor(limit);
  if (!(maxCategories > 0) || history.length === 0) {
    return [];
  }

  const statsByCategory = new Map<string, CategoryStats>();
  for (const entry of history) {
    if (!entry.category || nowMs - entry.readAt > TOP_CATEGORY_WINDOW_MS) {
      continue;
    }

    const existing = statsByCategory.get(entry.category);
    if (existing) {
      existing.count += 1;
      if (entry.readAt > existing.latestReadAt) {
        existing.latestReadAt = entry.readAt;
      }
    } else {
      statsByCategory.set(entry.category, {
        count: 1,
        latestReadAt: entry.readAt,
      });
    }
  }

  return Array.from(statsByCategory.entries())
    .sort(([catA, statsA], [catB, statsB]) => {
      if (statsB.count !== statsA.count) {
        return statsB.count - statsA.count;
      }
      if (statsB.latestReadAt !== statsA.latestReadAt) {
        return statsB.latestReadAt - statsA.latestReadAt;
      }
      return compareLexical(catA, catB);
    })
    .slice(0, maxCategories)
    .map(([category]) => category);
}

function compareArticlesNewestFirst(a: Article, b: Article): number {
  if (b.publishedAt !== a.publishedAt) {
    return b.publishedAt - a.publishedAt;
  }
  if (b.fetchedAt !== a.fetchedAt) {
    return b.fetchedAt - a.fetchedAt;
  }
  return compareLexical(a.id, b.id);
}

/**
 * Selects unread, uncached articles for Wi-Fi prefetching, prioritizing
 * keyword-matched articles ahead of articles in top-read categories.
 */
export function selectPrefetchCandidates(
  articles: Article[],
  topCategories: ReadonlySet<string>,
  matchedArticleIds: ReadonlySet<string>,
  cachedIds: ReadonlySet<string>,
  maxBatch?: number
): Article[] {
  const batchLimit = maxBatch === undefined ? undefined : Math.floor(maxBatch);
  if (batchLimit !== undefined && !(batchLimit > 0)) {
    return [];
  }

  const seenIds = new Set<string>();
  const matchedTier: Article[] = [];
  const topCategoryTier: Article[] = [];

  for (const article of articles) {
    if (
      article.isRead ||
      cachedIds.has(article.id) ||
      seenIds.has(article.id)
    ) {
      continue;
    }
    seenIds.add(article.id);

    if (matchedArticleIds.has(article.id)) {
      matchedTier.push(article);
    } else if (topCategories.has(article.category)) {
      topCategoryTier.push(article);
    }
  }

  matchedTier.sort(compareArticlesNewestFirst);
  topCategoryTier.sort(compareArticlesNewestFirst);

  const prioritized = [...matchedTier, ...topCategoryTier];
  return batchLimit === undefined
    ? prioritized
    : prioritized.slice(0, batchLimit);
}

function collectLruEvictions(
  entries: readonly CacheEntry[],
  maxBytes: number
): string[] {
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += Math.max(0, entry.sizeBytes);
  }

  if (totalBytes <= maxBytes) {
    return [];
  }

  const orderedOldestFirst = [...entries].sort((a, b) => {
    if (a.lastAccessedAt !== b.lastAccessedAt) {
      return a.lastAccessedAt - b.lastAccessedAt;
    }
    if (a.cachedAt !== b.cachedAt) {
      return a.cachedAt - b.cachedAt;
    }
    return compareLexical(a.articleId, b.articleId);
  });

  const evictedIds: string[] = [];
  for (const entry of orderedOldestFirst) {
    if (totalBytes <= maxBytes) {
      break;
    }
    evictedIds.push(entry.articleId);
    totalBytes -= Math.max(0, entry.sizeBytes);
  }

  return evictedIds;
}

/**
 * Computes deterministic cache and metadata purge lists:
 * - Unsaved article metadata older than 14 days is deleted; saved metadata is never deleted.
 * - Unsaved cache entries older than 72 hours (or whose metadata is purged) are deleted.
 * - Remaining unsaved (200 MB) and saved (50 MB) cache pools are capped independently via LRU.
 */
export function planPurge(
  articles: Article[],
  cacheEntries: CacheEntry[],
  nowMs: number
): { deleteCacheArticleIds: string[]; deleteMetadataArticleIds: string[] } {
  const articleById = new Map<string, Article>();
  const deleteMetadataSet = new Set<string>();

  for (const article of articles) {
    articleById.set(article.id, article);
    if (!article.isSaved && nowMs - article.fetchedAt > UNREAD_METADATA_TTL_MS) {
      deleteMetadataSet.add(article.id);
    }
  }

  const deleteCacheSet = new Set<string>();
  const unreadRemaining: CacheEntry[] = [];
  const savedRemaining: CacheEntry[] = [];

  for (const entry of cacheEntries) {
    const isSaved = articleById.get(entry.articleId)?.isSaved ?? false;
    if (
      !isSaved &&
      (deleteMetadataSet.has(entry.articleId) ||
        nowMs - entry.cachedAt > UNREAD_CACHE_TTL_MS)
    ) {
      deleteCacheSet.add(entry.articleId);
      continue;
    }

    if (isSaved) {
      savedRemaining.push(entry);
    } else {
      unreadRemaining.push(entry);
    }
  }

  for (const id of collectLruEvictions(unreadRemaining, UNREAD_CACHE_MAX_BYTES)) {
    deleteCacheSet.add(id);
  }
  for (const id of collectLruEvictions(savedRemaining, SAVED_CACHE_MAX_BYTES)) {
    deleteCacheSet.add(id);
  }

  return {
    deleteCacheArticleIds: Array.from(deleteCacheSet),
    deleteMetadataArticleIds: Array.from(deleteMetadataSet),
  };
}
