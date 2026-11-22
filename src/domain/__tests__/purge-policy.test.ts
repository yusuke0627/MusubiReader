import {
  getTopReadCategories,
  planPurge,
  SAVED_CACHE_MAX_BYTES,
  selectPrefetchCandidates,
  TOP_CATEGORY_LIMIT,
  TOP_CATEGORY_WINDOW_MS,
  UNREAD_CACHE_MAX_BYTES,
  UNREAD_CACHE_TTL_MS,
  UNREAD_METADATA_TTL_MS,
} from '../purge-policy';
import type { Article, CacheEntry, ReadHistoryEntry } from '../types';

const NOW_MS = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MB = 1024 * 1024;

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'art-1',
    packId: 'matome-5ch',
    siteId: 'site-1',
    siteName: 'Site 1',
    category: 'news',
    title: 'Sample Article',
    url: 'https://example.com/1',
    summary: 'Summary',
    tags: [],
    publishedAt: NOW_MS - HOUR_MS,
    fetchedAt: NOW_MS - HOUR_MS,
    isSaved: false,
    isRead: false,
    ...overrides,
  };
}

function makeCacheEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    articleId: 'art-1',
    localPath: '/cache/art-1/index.html',
    sizeBytes: 1 * MB,
    cachedAt: NOW_MS - HOUR_MS,
    lastAccessedAt: NOW_MS - HOUR_MS,
    ...overrides,
  };
}

function makeHistory(
  category: string,
  readAt: number,
  articleId = `hist-${category}-${readAt}`
): ReadHistoryEntry {
  return {
    articleId,
    category,
    readAt,
  };
}

describe('purge-policy constants', () => {
  test('exposes exact TTL, window, limit, and byte cap constants', () => {
    expect(UNREAD_CACHE_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(UNREAD_METADATA_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(UNREAD_CACHE_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(SAVED_CACHE_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(TOP_CATEGORY_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(TOP_CATEGORY_LIMIT).toBe(3);
  });
});

describe('getTopReadCategories', () => {
  test('ranks categories within last 14 days and returns top 3', () => {
    const history: ReadHistoryEntry[] = [
      // Expired (>14d): should be ignored even though tech has many old reads
      makeHistory('tech', NOW_MS - TOP_CATEGORY_WINDOW_MS - 1, 'old-1'),
      makeHistory('tech', NOW_MS - TOP_CATEGORY_WINDOW_MS - 10_000, 'old-2'),
      makeHistory('tech', NOW_MS - TOP_CATEGORY_WINDOW_MS - 20_000, 'old-3'),
      makeHistory('tech', NOW_MS - TOP_CATEGORY_WINDOW_MS - 30_000, 'old-4'),
      // Exact 14d boundary should be included
      makeHistory('games', NOW_MS - TOP_CATEGORY_WINDOW_MS, 'b-1'),
      makeHistory('games', NOW_MS - 2 * DAY_MS, 'g-2'),
      makeHistory('games', NOW_MS - 1 * DAY_MS, 'g-3'),
      // Top 1: anime (4 reads)
      makeHistory('anime', NOW_MS - 5 * DAY_MS, 'a-1'),
      makeHistory('anime', NOW_MS - 4 * DAY_MS, 'a-2'),
      makeHistory('anime', NOW_MS - 3 * DAY_MS, 'a-3'),
      makeHistory('anime', NOW_MS - 1 * HOUR_MS, 'a-4'),
      // Top 3: news (2 reads)
      makeHistory('news', NOW_MS - 2 * DAY_MS, 'n-1'),
      makeHistory('news', NOW_MS - 1 * DAY_MS, 'n-2'),
      // 4th: misc (1 read)
      makeHistory('misc', NOW_MS - 1 * HOUR_MS, 'm-1'),
    ];

    expect(getTopReadCategories(history, NOW_MS)).toEqual([
      'anime',
      'games',
      'news',
    ]);
  });

  test('respects custom limit, handles ties deterministically, and returns empty for limit <= 0', () => {
    const history: ReadHistoryEntry[] = [
      makeHistory('alpha', NOW_MS - 3 * DAY_MS, '1'),
      makeHistory('beta', NOW_MS - 1 * DAY_MS, '2'),
      makeHistory('gamma', NOW_MS - 2 * DAY_MS, '3'),
    ];

    expect(getTopReadCategories(history, NOW_MS, 2)).toEqual([
      'beta',
      'gamma',
    ]);
    expect(getTopReadCategories(history, NOW_MS, 0)).toEqual([]);
    expect(getTopReadCategories([], NOW_MS)).toEqual([]);
  });
});

describe('selectPrefetchCandidates', () => {
  test('prioritizes keyword-matched articles then top-category unread articles', () => {
    const articles: Article[] = [
      // Top-category unread (older)
      makeArticle({
        id: 'top-older',
        category: 'games',
        publishedAt: NOW_MS - 3 * HOUR_MS,
      }),
      // Already cached keyword match -> must be skipped
      makeArticle({
        id: 'matched-cached',
        category: 'misc',
        publishedAt: NOW_MS - 10_000,
      }),
      // Keyword-matched AND in top category -> appears once in keyword-matched tier
      makeArticle({
        id: 'matched-newer',
        category: 'games',
        publishedAt: NOW_MS - 1 * HOUR_MS,
      }),
      // Keyword-matched outside top category -> still in priority tier 1
      makeArticle({
        id: 'matched-older',
        category: 'misc',
        publishedAt: NOW_MS - 2 * HOUR_MS,
      }),
      // Top-category unread (newer)
      makeArticle({
        id: 'top-newer',
        category: 'anime',
        publishedAt: NOW_MS - 30 * 60 * 1000,
      }),
      // Already read in top category -> skipped
      makeArticle({
        id: 'top-read',
        category: 'anime',
        isRead: true,
        publishedAt: NOW_MS - 1_000,
      }),
      // Already cached in top category -> skipped
      makeArticle({
        id: 'top-cached',
        category: 'anime',
        publishedAt: NOW_MS - 2_000,
      }),
      // Neither keyword-matched nor top-category -> excluded
      makeArticle({
        id: 'other-unread',
        category: 'misc',
        publishedAt: NOW_MS - 500,
      }),
    ];

    const topCategories = new Set(['games', 'anime']);
    const matchedIds = new Set([
      'matched-cached',
      'matched-newer',
      'matched-older',
    ]);
    const cachedIds = new Set(['matched-cached', 'top-cached']);

    const selected = selectPrefetchCandidates(
      articles,
      topCategories,
      matchedIds,
      cachedIds
    );

    expect(selected.map((a) => a.id)).toEqual([
      'matched-newer',
      'matched-older',
      'top-newer',
      'top-older',
    ]);
  });

  test('respects maxBatch limit', () => {
    const articles = [
      makeArticle({ id: 'm1', category: 'misc', publishedAt: NOW_MS - 1_000 }),
      makeArticle({ id: 'm2', category: 'misc', publishedAt: NOW_MS - 2_000 }),
      makeArticle({ id: 't1', category: 'games', publishedAt: NOW_MS - 500 }),
    ];

    const selected = selectPrefetchCandidates(
      articles,
      new Set(['games']),
      new Set(['m1', 'm2']),
      new Set(),
      2
    );

    expect(selected.map((a) => a.id)).toEqual(['m1', 'm2']);
    expect(
      selectPrefetchCandidates(
        articles,
        new Set(['games']),
        new Set(['m1']),
        new Set(),
        0
      )
    ).toEqual([]);
  });
});

describe('planPurge', () => {
  test('planPurge deletes unread cache >72h and unread metadata >14d while NEVER deleting saved article metadata', () => {
    const articles: Article[] = [
      // Unread cache exactly at 72h boundary -> keep cache & metadata
      makeArticle({
        id: 'unread-72h-exact',
        fetchedAt: NOW_MS - UNREAD_CACHE_TTL_MS,
      }),
      // Unread cache >72h (72h + 1ms) -> delete cache, keep metadata
      makeArticle({
        id: 'unread-72h-expired',
        fetchedAt: NOW_MS - UNREAD_CACHE_TTL_MS - 1,
      }),
      // Unread metadata exactly at 14d -> keep metadata
      makeArticle({
        id: 'unread-14d-exact',
        fetchedAt: NOW_MS - UNREAD_METADATA_TTL_MS,
      }),
      // Unread metadata >14d -> delete metadata (and any cache if present)
      makeArticle({
        id: 'unread-14d-expired',
        fetchedAt: NOW_MS - UNREAD_METADATA_TTL_MS - 1,
      }),
      // Saved article >14d and cached >72h -> NEVER delete metadata or cache (under 50MB)
      makeArticle({
        id: 'saved-old',
        isSaved: true,
        fetchedAt: NOW_MS - 30 * DAY_MS,
      }),
    ];

    const cacheEntries: CacheEntry[] = [
      makeCacheEntry({
        articleId: 'unread-72h-exact',
        cachedAt: NOW_MS - UNREAD_CACHE_TTL_MS,
        lastAccessedAt: NOW_MS - UNREAD_CACHE_TTL_MS,
      }),
      makeCacheEntry({
        articleId: 'unread-72h-expired',
        cachedAt: NOW_MS - UNREAD_CACHE_TTL_MS - 1,
        lastAccessedAt: NOW_MS - UNREAD_CACHE_TTL_MS - 1,
      }),
      makeCacheEntry({
        articleId: 'saved-old',
        cachedAt: NOW_MS - 30 * DAY_MS,
        lastAccessedAt: NOW_MS - 30 * DAY_MS,
      }),
    ];

    const plan = planPurge(articles, cacheEntries, NOW_MS);

    expect(plan.deleteCacheArticleIds).toEqual(['unread-72h-expired']);
    expect(plan.deleteMetadataArticleIds).toEqual(['unread-14d-expired']);
  });

  test('planPurge enforces 200MB unread LRU cap and separate 50MB saved cache cap independently', () => {
    const articles: Article[] = [
      makeArticle({ id: 'u-oldest', fetchedAt: NOW_MS - 10 * HOUR_MS }),
      makeArticle({ id: 'u-middle', fetchedAt: NOW_MS - 5 * HOUR_MS }),
      makeArticle({ id: 'u-newest', fetchedAt: NOW_MS - 1 * HOUR_MS }),
      makeArticle({
        id: 's-oldest',
        isSaved: true,
        fetchedAt: NOW_MS - 30 * DAY_MS,
      }),
      makeArticle({
        id: 's-newest',
        isSaved: true,
        fetchedAt: NOW_MS - 20 * DAY_MS,
      }),
    ];

    // Part 1: Unread = 220MB (>200MB), Saved = 40MB (<=50MB)
    // Expect only u-oldest (80MB) evicted so unread drops to 140MB <= 200MB, saved untouched
    const cacheOverUnreadOnly: CacheEntry[] = [
      makeCacheEntry({
        articleId: 'u-oldest',
        sizeBytes: 80 * MB,
        lastAccessedAt: NOW_MS - 30 * HOUR_MS,
      }),
      makeCacheEntry({
        articleId: 'u-middle',
        sizeBytes: 70 * MB,
        lastAccessedAt: NOW_MS - 20 * HOUR_MS,
      }),
      makeCacheEntry({
        articleId: 'u-newest',
        sizeBytes: 70 * MB,
        lastAccessedAt: NOW_MS - 10 * HOUR_MS,
      }),
      makeCacheEntry({
        articleId: 's-oldest',
        sizeBytes: 20 * MB,
        lastAccessedAt: NOW_MS - 100 * DAY_MS,
      }),
      makeCacheEntry({
        articleId: 's-newest',
        sizeBytes: 20 * MB,
        lastAccessedAt: NOW_MS - 1 * HOUR_MS,
      }),
    ];

    const plan1 = planPurge(articles, cacheOverUnreadOnly, NOW_MS);
    expect(plan1.deleteCacheArticleIds).toEqual(['u-oldest']);
    expect(plan1.deleteMetadataArticleIds).toEqual([]);

    // Part 2: Unread = 200MB (exact cap -> 0 evicted), Saved = 60MB (>50MB)
    // Expect only s-oldest (25MB) evicted so saved drops to 35MB <= 50MB; saved metadata still NEVER deleted
    const cacheOverSavedOnly: CacheEntry[] = [
      makeCacheEntry({
        articleId: 'u-oldest',
        sizeBytes: UNREAD_CACHE_MAX_BYTES,
        lastAccessedAt: NOW_MS - 30 * HOUR_MS,
      }),
      makeCacheEntry({
        articleId: 's-oldest',
        sizeBytes: 25 * MB,
        lastAccessedAt: NOW_MS - 10 * DAY_MS,
      }),
      makeCacheEntry({
        articleId: 's-newest',
        sizeBytes: SAVED_CACHE_MAX_BYTES - 15 * MB, // 35MB -> total 60MB
        lastAccessedAt: NOW_MS - 1 * HOUR_MS,
      }),
    ];

    const plan2 = planPurge(articles, cacheOverSavedOnly, NOW_MS);
    expect(plan2.deleteCacheArticleIds).toEqual(['s-oldest']);
    expect(plan2.deleteMetadataArticleIds).toEqual([]);
  });

  test('applies unread TTL deletions before computing 200MB LRU eviction', () => {
    const articles: Article[] = [
      makeArticle({ id: 'u-expired-ttl', fetchedAt: NOW_MS - 4 * DAY_MS }),
      makeArticle({ id: 'u-fresh', fetchedAt: NOW_MS - 2 * HOUR_MS }),
    ];

    const cacheEntries: CacheEntry[] = [
      makeCacheEntry({
        articleId: 'u-expired-ttl',
        sizeBytes: 150 * MB,
        cachedAt: NOW_MS - UNREAD_CACHE_TTL_MS - 1,
        lastAccessedAt: NOW_MS - UNREAD_CACHE_TTL_MS - 1,
      }),
      makeCacheEntry({
        articleId: 'u-fresh',
        sizeBytes: 100 * MB,
        cachedAt: NOW_MS - 2 * HOUR_MS,
        lastAccessedAt: NOW_MS - 2 * HOUR_MS,
      }),
    ];

    const plan = planPurge(articles, cacheEntries, NOW_MS);
    expect(plan.deleteCacheArticleIds).toEqual(['u-expired-ttl']);
    expect(plan.deleteMetadataArticleIds).toEqual([]);
  });
});
