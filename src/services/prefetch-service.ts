import iconv from 'iconv-lite';
import type { ArticleRepository } from '../data/repositories/article-repository';
import type { CatalogRepository } from '../data/repositories/catalog-repository';
import type { SettingsRepository } from '../data/repositories/settings-repository';
import {
  detectBomOrHeaderCharset,
  normalizeCharset,
  readAsciiPrefix,
} from '../domain/charset';
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
export const MAX_INLINE_STYLESHEETS = 6;
export const DEFAULT_PREFETCH_BATCH_SIZE = 20;
export const MOBILE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const MOBILE_HTML_HEADERS: Record<string, string> = {
  'User-Agent': MOBILE_SAFARI_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
};

const MOBILE_ASSET_HEADERS: Record<string, string> = {
  'User-Agent': MOBILE_SAFARI_USER_AGENT,
};

const LINK_TAG_REGEX = /<link\b[^>]*>/gi;
const CSS_URL_REGEX = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const SAFE_MOBILE_STYLE_TAG =
  '<style data-musubi-safe="1">html,body{max-width:100%!important;overflow-x:hidden!important;}img,video{max-width:100%!important;height:auto!important;}</style>';

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
  catalogRepo?: Pick<CatalogRepository, 'getResolvedFeeds'>;
  networkState?: NetworkStateProvider;
  fileStore?: PrefetchFileStore;
  fetcher?: typeof fetch;
  now?: () => number;
  maxBatch?: number;
  maxImagesPerArticle?: number;
  concurrency?: number;
  timeoutMs?: number;
  preferredPackId?: string;
  preferredCategory?: string;
  signal?: AbortSignal;
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
const META_TAG_REGEX = /<meta\b[^>]*>/gi;
const BASE_TAG_REGEX = /<base\b[^>]*>/gi;
const ATTR_REGEX_CACHE = new Map<string, RegExp>();

function extractAttribute(tag: string, attrName: string): string | null {
  let regex = ATTR_REGEX_CACHE.get(attrName);
  if (!regex) {
    regex = new RegExp(
      `(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
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

function decodeHtmlUrlEntities(rawUrl: string): string {
  return rawUrl.replace(/&amp;/gi, '&');
}

function resolveImageCandidateUrl(rawCandidate: string, baseUrl: string): string | null {
  if (!rawCandidate || rawCandidate.startsWith('data:')) {
    return null;
  }
  try {
    const resolved = new URL(decodeHtmlUrlEntities(rawCandidate), baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function resolveFirstImageUrlFromTag(tag: string, baseUrl: string): string | null {
  const candidates = [
    extractAttribute(tag, 'data-src'),
    extractAttribute(tag, 'data-original'),
    extractAttribute(tag, 'data-lazy-src'),
    extractAttribute(tag, 'src'),
  ];

  for (const rawCandidate of candidates) {
    if (!rawCandidate) {
      continue;
    }
    const resolved = resolveImageCandidateUrl(rawCandidate, baseUrl);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function stripAttribute(tag: string, attrName: string): string {
  const regex = new RegExp(
    `\\s+${attrName}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>` + '`' + `]+)`,
    'gi'
  );
  return tag.replace(regex, '');
}

function normalizeImgTagToLocal(tag: string, localFilename: string): string {
  let updated = tag;
  for (const attr of [
    'data-src',
    'data-original',
    'data-lazy-src',
    'srcset',
    'data-srcset',
  ]) {
    updated = stripAttribute(updated, attr);
  }

  const srcAttrRegex = /(\s)src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i;
  if (srcAttrRegex.test(updated)) {
    return updated.replace(srcAttrRegex, `$1src="${localFilename}"`);
  }

  return updated.replace(/^<img\b/i, `<img src="${localFilename}"`);
}

function resolveDocumentBaseUrl(html: string, fallbackUrl: string): string {
  const baseMatch = BASE_TAG_REGEX.exec(html);
  BASE_TAG_REGEX.lastIndex = 0;
  if (!baseMatch) {
    return fallbackUrl;
  }
  const href = extractAttribute(baseMatch[0], 'href');
  if (!href) {
    return fallbackUrl;
  }
  try {
    return new URL(decodeHtmlUrlEntities(href), fallbackUrl).toString();
  } catch {
    return fallbackUrl;
  }
}

/**
 * Decodes HTML bytes using BOM, HTTP Content-Type charset, or `<meta charset>`
 * before falling back to UTF-8.
 */
export function decodeHtmlBytes(
  bytes: Uint8Array,
  contentType?: string
): string {
  const fromBomOrHeader = detectBomOrHeaderCharset(bytes, contentType);
  if (fromBomOrHeader) {
    return iconv.decode(bytes, fromBomOrHeader);
  }

  const head = readAsciiPrefix(bytes, 4096);
  for (const metaMatch of head.matchAll(META_TAG_REGEX)) {
    const tag = metaMatch[0];
    const directCharset = /\bcharset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(tag);
    const contentCharset = /charset\s*=\s*([a-zA-Z0-9._-]+)/i.exec(
      extractAttribute(tag, 'content') ?? ''
    );
    const normalized = normalizeCharset(directCharset?.[1] ?? contentCharset?.[1]);
    if (normalized) {
      return iconv.decode(bytes, normalized);
    }
  }

  return decodeUtf8(bytes);
}

function rewriteCssRelativeUrls(css: string, stylesheetUrl: string): string {
  return css.replace(CSS_URL_REGEX, (match, quote: string, rawRef: string) => {
    const trimmed = rawRef.trim();
    if (
      !trimmed ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://')
    ) {
      return match;
    }
    try {
      const absolute = new URL(trimmed, stylesheetUrl).toString();
      return `url(${quote}${absolute}${quote})`;
    } catch {
      return match;
    }
  });
}

function isStylesheetLinkTag(tag: string): boolean {
  const rel = extractAttribute(tag, 'rel');
  if (!rel) {
    return false;
  }
  return rel
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet');
}

/**
 * Extracts up to `limit` unique HTTP(S) stylesheet URLs from `<link rel="stylesheet">` tags.
 */
export function extractStylesheetUrls(
  html: string,
  baseUrl: string,
  limit: number = MAX_INLINE_STYLESHEETS
): string[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0 || !html) {
    return [];
  }
  const effectiveBase = resolveDocumentBaseUrl(html, baseUrl);
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of html.matchAll(LINK_TAG_REGEX)) {
    if (urls.length >= safeLimit) {
      break;
    }
    const tag = match[0];
    if (!isStylesheetLinkTag(tag)) {
      continue;
    }
    const href = extractAttribute(tag, 'href');
    if (!href) {
      continue;
    }
    const resolved = resolveImageCandidateUrl(href, effectiveBase);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      urls.push(resolved);
    }
  }

  return urls;
}

export interface RewrittenCachedHtmlResult {
  readonly html: string;
  readonly blockedCount: number;
}

/**
 * Rewrites cached HTML and returns both the output HTML and the exact count of
 * stripped `<script>` / `<iframe>` elements embedded in `<meta name="musubi-blocked-count">`.
 */
export function rewriteCachedHtmlWithStats(
  html: string,
  baseUrl: string,
  localFilesByUrl: ReadonlyMap<string, string>,
  inlinedStylesByUrl?: ReadonlyMap<string, string>
): RewrittenCachedHtmlResult {
  let updated = html.replace(IMG_TAG_REGEX, (tag) => {
    const resolvedUrl = resolveFirstImageUrlFromTag(tag, baseUrl);
    if (!resolvedUrl) {
      return tag;
    }
    const localFilename = localFilesByUrl.get(resolvedUrl);
    if (!localFilename) {
      return tag;
    }
    return normalizeImgTagToLocal(tag, localFilename);
  });

  updated = updated.replace(LINK_TAG_REGEX, (tag) => {
    if (!isStylesheetLinkTag(tag)) {
      return tag;
    }
    const href = extractAttribute(tag, 'href');
    if (!href) {
      return tag;
    }
    const resolved = resolveImageCandidateUrl(href, baseUrl);
    if (resolved && inlinedStylesByUrl?.has(resolved)) {
      const css = inlinedStylesByUrl.get(resolved) ?? '';
      const safeCss = css.replace(/<\/style/gi, '<\\/style');
      return `<style data-musubi-inlined="1">${safeCss}</style>`;
    }
    if (resolved) {
      return tag.replace(
        /(\shref\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i,
        `$1"${resolved}"`
      );
    }
    return tag;
  });

  // Remove <base> tags so relative local filenames (`img-0.*`) resolve inside the cache folder.
  updated = updated.replace(BASE_TAG_REGEX, '');

  // Strip external scripts and iframes so cached local HTML renders immediately without slow network stalls.
  let blockedCount = 0;
  updated = updated.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => {
    blockedCount += 1;
    return '';
  });
  updated = updated.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, () => {
    blockedCount += 1;
    return '';
  });
  updated = updated.replace(/<iframe\b[^>]*\/?>/gi, () => {
    blockedCount += 1;
    return '';
  });

  let hasCharsetMeta = false;
  let hasViewportMeta = false;
  updated = updated.replace(META_TAG_REGEX, (tag) => {
    const nameAttr = extractAttribute(tag, 'name')?.toLowerCase();
    if (nameAttr === 'viewport') {
      hasViewportMeta = true;
    }
    if (/\bcharset\s*=/i.test(tag)) {
      hasCharsetMeta = true;
      return tag.replace(/(charset\s*=\s*["']?)[a-zA-Z0-9._-]+/gi, '$1utf-8');
    }
    return tag;
  });

  const headInjections: string[] = [];
  if (!hasCharsetMeta) {
    headInjections.push('<meta charset="utf-8">');
  }
  if (!hasViewportMeta) {
    headInjections.push(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    );
  }
  headInjections.push(
    `<meta name="musubi-blocked-count" content="${blockedCount}">`
  );
  headInjections.push(SAFE_MOBILE_STYLE_TAG);
  const injectionHtml = headInjections.join('');

  if (/<head\b[^>]*>/i.test(updated)) {
    updated = updated.replace(
      /<head\b[^>]*>/i,
      (match) => `${match}${injectionHtml}`
    );
  } else if (/<html\b[^>]*>/i.test(updated)) {
    updated = updated.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}<head>${injectionHtml}</head>`
    );
  } else {
    updated = `${injectionHtml}${updated}`;
  }

  return { html: updated, blockedCount };
}

/**
 * Rewrites matched `<img>` tags in cached HTML to reference locally downloaded
 * relative `img-*` files, inlines downloaded stylesheets, removes `<base>` / scripts / iframes,
 * normalizes charset meta tags to UTF-8, and ensures a mobile viewport + responsive guard CSS.
 */
export function rewriteCachedHtml(
  html: string,
  baseUrl: string,
  localFilesByUrl: ReadonlyMap<string, string>,
  inlinedStylesByUrl?: ReadonlyMap<string, string>
): string {
  return rewriteCachedHtmlWithStats(
    html,
    baseUrl,
    localFilesByUrl,
    inlinedStylesByUrl
  ).html;
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

    const resolved = resolveFirstImageUrlFromTag(match[0], baseUrl);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      urls.push(resolved);
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

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  return new Uint8Array(iconv.encode(text, 'utf-8'));
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
  nowMs: number,
  signal?: AbortSignal
): Promise<{ articleId: string; localPath: string; sizeBytes: number } | null> {
  if (signal?.aborted) {
    return null;
  }
  try {
    const htmlRes = await fetchWithTimeout(
      article.url,
      fetcher,
      timeoutMs,
      { headers: MOBILE_HTML_HEADERS },
      signal
    );
    if (!htmlRes.ok || signal?.aborted) {
      return null;
    }

    const htmlBytes = new Uint8Array(await htmlRes.arrayBuffer());
    const contentType = htmlRes.headers.get('content-type') ?? undefined;
    const articleDir = getArticlePrefetchDir(fileStore.cacheDirectory, article.id);
    const htmlPath = `${articleDir}index.html`;

    const htmlText = decodeHtmlBytes(htmlBytes, contentType);
    const finalHtmlUrl = htmlRes.url || article.url;
    const effectiveBaseUrl = resolveDocumentBaseUrl(htmlText, finalHtmlUrl);
    const stylesheetUrls = extractStylesheetUrls(
      htmlText,
      effectiveBaseUrl,
      MAX_INLINE_STYLESHEETS
    );
    const imageUrls = extractPrimaryImageUrls(
      htmlText,
      effectiveBaseUrl,
      maxImages
    );

    let totalBytes = 0;
    const inlinedStylesByUrl = new Map<string, string>();
    const localFilesByUrl = new Map<string, string>();

    for (const cssUrl of stylesheetUrls) {
      if (signal?.aborted) {
        return null;
      }
      try {
        const cssRes = await fetchWithTimeout(
          cssUrl,
          fetcher,
          timeoutMs,
          { headers: MOBILE_ASSET_HEADERS },
          signal
        );
        if (!cssRes.ok) {
          continue;
        }
        const cssBytes = new Uint8Array(await cssRes.arrayBuffer());
        const cssContentType = cssRes.headers.get('content-type') ?? undefined;
        const decodedCss = decodeHtmlBytes(cssBytes, cssContentType);
        const rewrittenCss = rewriteCssRelativeUrls(
          decodedCss,
          cssRes.url || cssUrl
        );
        inlinedStylesByUrl.set(cssUrl, rewrittenCss);
      } catch {
        // Individual stylesheet failure should not abort caching the article.
      }
    }

    for (let i = 0; i < imageUrls.length; i += 1) {
      if (signal?.aborted) {
        return null;
      }
      const imageUrl = imageUrls[i];
      try {
        const imgRes = await fetchWithTimeout(
          imageUrl,
          fetcher,
          timeoutMs,
          { headers: MOBILE_ASSET_HEADERS },
          signal
        );
        if (!imgRes.ok) {
          continue;
        }
        const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
        const ext = getImageExtension(imageUrl);
        const filename = `img-${i}${ext}`;
        totalBytes += await fileStore.writeFile(
          `${articleDir}${filename}`,
          imgBytes
        );
        localFilesByUrl.set(imageUrl, filename);
      } catch {
        // Individual image fetch failure should not discard the cached HTML.
      }
    }

    const rewrittenHtml = rewriteCachedHtml(
      htmlText,
      effectiveBaseUrl,
      localFilesByUrl,
      inlinedStylesByUrl
    );
    totalBytes += await fileStore.writeFile(htmlPath, encodeUtf8(rewrittenHtml));

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
    resolvedFeeds,
  ] = await Promise.all([
    deps.articleRepo.listAllArticles(),
    deps.articleRepo.listCacheEntries(),
    deps.articleRepo.listReadHistory(nowMs - TOP_CATEGORY_WINDOW_MS),
    deps.settingsRepo.listInterestKeywords(),
    deps.settingsRepo.listNgWords(),
    deps.settingsRepo.listFeedOverrides(),
    deps.settingsRepo.listCustomFeeds(),
    deps.catalogRepo ? deps.catalogRepo.getResolvedFeeds() : Promise.resolve(null),
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

  const enabledSiteIds = resolvedFeeds
    ? new Set(
        resolvedFeeds
          .filter((feed) => feed.enabled && !feed.muted)
          .map((feed) => feed.siteId)
      )
    : null;

  const unblockedArticles = remainingArticles.filter(
    (article) =>
      (!enabledSiteIds || enabledSiteIds.has(article.siteId)) &&
      !isArticleBlocked(article, ngWords, mutedSiteIds)
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
    maxBatch,
    {
      preferredPackId: deps.preferredPackId,
      preferredCategory: deps.preferredCategory,
    }
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
        nowMs,
        deps.signal
      ),
    deps.signal
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
