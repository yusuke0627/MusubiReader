import iconv from 'iconv-lite';
import type { ArticleRepository } from '../data/repositories/article-repository';
import type { SettingsRepository } from '../data/repositories/settings-repository';
import { curatePickupArticles, isArticleBlocked } from '../domain/curation';
import {
  getTopReadCategories,
  planPurge,
  selectPrefetchCandidates,
  TOP_CATEGORY_WINDOW_MS,
} from '../domain/purge-policy';
import type { Article } from '../domain/types';
import {
  DEFAULT_FETCH_CONCURRENCY,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  mapWithConcurrency,
} from './fetch-utils';

export const PREFETCH_DIR_NAME = 'musubi-prefetch';
export const MAX_PRIMARY_IMAGES = 5;
export const DEFAULT_PREFETCH_BATCH_SIZE = 20;

export interface NetworkStateLike {
  type?: string;
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

export interface NetworkStateProvider {
  getNetworkStateAsync(): Promise<NetworkStateLike>;
}

export interface PrefetchFileStore {
  readonly cacheDirectory: string;
  writeFile(filePath: string, data: Uint8Array): Promise<number>;
  deletePath(targetPath: string): Promise<void>;
}

export interface PrefetchServiceDeps {
  articleRepo: Pick<
    ArticleRepository,
    | 'listAllArticles'
    | 'listCacheEntries'
    | 'listReadHistory'
    | 'upsertCacheEntry'
    | 'applyPurgePlan'
  >;
  settingsRepo: Pick<
    SettingsRepository,
    'listInterestKeywords' | 'listNgWords' | 'listFeedOverrides' | 'listCustomFeeds'
  >;
  networkState?: NetworkStateProvider;
  fileStore?: PrefetchFileStore;
  fetcher?: typeof fetch;
  now?: () => number;
  maxBatch?: number;
  maxImagesPerArticle?: number;
  concurrency?: number;
  timeoutMs?: number;
}

export interface WifiPrefetchAndPurgeResult {
  skippedNotWifi: boolean;
  prefetchedCount: number;
  purgedCacheCount: number;
  purgedMetadataCount: number;
}

function normalizeBaseDir(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

function safePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_') || 'article';
}

export function getArticlePrefetchDir(
  cacheDirectory: string,
  articleId: string
): string {
  return `${normalizeBaseDir(cacheDirectory)}${PREFETCH_DIR_NAME}/${safePathSegment(articleId)}/`;
}

const IMG_TAG_REGEX = /<img\b[^>]*>/gi;
const ATTR_REGEX_CACHE = new Map<string, RegExp>();

function extractAttribute(tag: string, attrName: string): string | null {
  let regex = ATTR_REGEX_CACHE.get(attrName);
  if (!regex) {
    regex = new RegExp(
      `\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
      'i'
    );
    ATTR_REGEX_CACHE.set(attrName, regex);
  }
  const match = regex.exec(tag);
  if (!match) {
    return null;
  }
  return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null;
}

/**
 * Extracts up to `limit` unique HTTP(S) primary image URLs from an HTML document,
 * resolving relative references against `baseUrl` and handling lazy-load attributes.
 */
export function extractPrimaryImageUrls(
  html: string,
  baseUrl: string,
  limit: number = MAX_PRIMARY_IMAGES
): string[] {
  if (!html || limit <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of html.matchAll(IMG_TAG_REGEX)) {
    if (urls.length >= limit) {
      break;
    }

    const tag = match[0];
    const candidates = [
      extractAttribute(tag, 'data-src'),
      extractAttribute(tag, 'data-original'),
      extractAttribute(tag, 'data-lazy-src'),
      extractAttribute(tag, 'src'),
    ];

    for (const rawCandidate of candidates) {
      if (!rawCandidate || rawCandidate.startsWith('data:')) {
        continue;
      }

      try {
        const resolved = new URL(rawCandidate, baseUrl);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
          continue;
        }
        const normalized = resolved.toString();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          urls.push(normalized);
        }
        break;
      } catch {
        continue;
      }
    }
  }

  return urls;
}

function getImageExtension(imageUrl: string): string {
  try {
    const pathname = new URL(imageUrl).pathname.toLowerCase();
    const match = /\.(jpg|jpeg|png|webp|gif|avif|svg)$/.exec(pathname);
    return match ? `.${match[1]}` : '.img';
  } catch {
    return '.img';
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  return iconv.decode(bytes, 'utf-8');
}

/**
 * Default Expo runtime network state provider using `expo-network`.
 */
export function createExpoNetworkStateProvider(): NetworkStateProvider {
  return {
    async getNetworkStateAsync() {
      const Network = await import('expo-network');
      return Network.getNetworkStateAsync();
    },
  };
}

/**
 * Default Expo runtime file store using `expo-file-system`.
 */
export async function createExpoFileStore(): Promise<PrefetchFileStore> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const cacheDirectory = normalizeBaseDir(Paths.cache.uri);

  return {
    cacheDirectory,
    async writeFile(filePath: string, data: Uint8Array): Promise<number> {
      const file = new File(filePath);
      const parent = file.parentDirectory;
      if (!parent.exists) {
        parent.create({ intermediates: true, idempotent: true });
      }
      file.create({ intermediates: true, overwrite: true });
      await file.write(data);
      return data.byteLength;
    },
    async deletePath(targetPath: string): Promise<void> {
      const info = Paths.info(targetPath);
      if (!info.exists) {
        return;
      }
      if (info.isDirectory) {
        new Directory(targetPath).delete();
      } else {
        new File(targetPath).delete();
      }
    },
  };
}

async function prefetchSingleArticle(
  article: Article,
  fileStore: PrefetchFileStore,
  fetcher: typeof fetch,
  timeoutMs: number,
  maxImages: number,
  nowMs: number
): Promise<{ articleId: string; localPath: string; sizeBytes: number } | null> {
  try {
    const htmlRes = await fetchWithTimeout(article.url, fetcher, timeoutMs);
    if (!htmlRes.ok) {
      return null;
    }

    const htmlBytes = new Uint8Array(await htmlRes.arrayBuffer());
    const articleDir = getArticlePrefetchDir(fileStore.cacheDirectory, article.id);
    const htmlPath = `${articleDir}index.html`;
    let totalBytes = await fileStore.writeFile(htmlPath, htmlBytes);

    const htmlText = decodeUtf8(htmlBytes);
    const imageUrls = extractPrimaryImageUrls(htmlText, article.url, maxImages);

    for (let i = 0; i < imageUrls.length; i += 1) {
      const imageUrl = imageUrls[i];
      try {
        const imgRes = await fetchWithTimeout(imageUrl, fetcher, timeoutMs);
        if (!imgRes.ok) {
          continue;
        }
        const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
        const ext = getImageExtension(imageUrl);
        totalBytes += await fileStore.writeFile(
          `${articleDir}img-${i}${ext}`,
          imgBytes
        );
      } catch {
        // Individual image fetch failure should not discard the cached HTML.
      }
    }

    return {
      articleId: article.id,
      localPath: htmlPath,
      sizeBytes: totalBytes,
    };
  } catch {
    return null;
  }
}

/**
 * Applies TTL/LRU cache and metadata purge locally, then—only when connected via
 * Wi-Fi—downloads HTML and up to 5 primary images for prioritized unread articles.
 */
export async function runWifiPrefetchAndPurge(
  deps: PrefetchServiceDeps
): Promise<WifiPrefetchAndPurgeResult> {
  const networkState = deps.networkState ?? createExpoNetworkStateProvider();
  const fileStore = deps.fileStore ?? (await createExpoFileStore());
  const fetcher = deps.fetcher ?? fetch;
  const nowMs = (deps.now ?? Date.now)();
  const maxBatch = deps.maxBatch ?? DEFAULT_PREFETCH_BATCH_SIZE;
  const maxImages = deps.maxImagesPerArticle ?? MAX_PRIMARY_IMAGES;
  const concurrency = deps.concurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const [initialArticles, initialCacheEntries] = await Promise.all([
    deps.articleRepo.listAllArticles(),
    deps.articleRepo.listCacheEntries(),
  ]);

  const purgePlan = planPurge(initialArticles, initialCacheEntries, nowMs);
  for (const articleId of purgePlan.deleteCacheArticleIds) {
    await fileStore.deletePath(
      getArticlePrefetchDir(fileStore.cacheDirectory, articleId)
    );
  }
  await deps.articleRepo.applyPurgePlan(purgePlan);

  const purgedCacheCount = purgePlan.deleteCacheArticleIds.length;
  const purgedMetadataCount = purgePlan.deleteMetadataArticleIds.length;

  const net = await networkState.getNetworkStateAsync();
  if (net.type !== 'WIFI' || net.isConnected === false) {
    return {
      skippedNotWifi: true,
      prefetchedCount: 0,
      purgedCacheCount,
      purgedMetadataCount,
    };
  }

  const [
    remainingArticles,
    remainingCacheEntries,
    readHistory,
    keywords,
    ngWords,
    overrides,
    customFeeds,
  ] = await Promise.all([
    deps.articleRepo.listAllArticles(),
    deps.articleRepo.listCacheEntries(),
    deps.articleRepo.listReadHistory(nowMs - TOP_CATEGORY_WINDOW_MS),
    deps.settingsRepo.listInterestKeywords(),
    deps.settingsRepo.listNgWords(),
    deps.settingsRepo.listFeedOverrides(),
    deps.settingsRepo.listCustomFeeds(),
  ]);

  const mutedSiteIds = new Set<string>();
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

  const unblockedArticles = remainingArticles.filter(
    (article) => !isArticleBlocked(article, ngWords, mutedSiteIds)
  );
  const pickupMatched = curatePickupArticles(
    unblockedArticles,
    keywords,
    ngWords,
    mutedSiteIds
  );
  const matchedArticleIds = new Set(
    pickupMatched.map((entry) => entry.article.id)
  );
  const topCategories = new Set(getTopReadCategories(readHistory, nowMs));
  const cachedIds = new Set(
    remainingCacheEntries.map((entry) => entry.articleId)
  );

  const candidates = selectPrefetchCandidates(
    unblockedArticles,
    topCategories,
    matchedArticleIds,
    cachedIds,
    maxBatch
  );

  const downloaded = await mapWithConcurrency(
    candidates,
    concurrency,
    (article) =>
      prefetchSingleArticle(
        article,
        fileStore,
        fetcher,
        timeoutMs,
        maxImages,
        nowMs
      )
  );

  let prefetchedCount = 0;
  for (const entry of downloaded) {
    if (!entry) {
      continue;
    }
    await deps.articleRepo.upsertCacheEntry({
      articleId: entry.articleId,
      localPath: entry.localPath,
      sizeBytes: entry.sizeBytes,
      cachedAt: nowMs,
      lastAccessedAt: nowMs,
    });
    prefetchedCount += 1;
  }

  return {
    skippedNotWifi: false,
    prefetchedCount,
    purgedCacheCount,
    purgedMetadataCount,
  };
}
