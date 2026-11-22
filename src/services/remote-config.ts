import {
  compileAdBlockRules,
  DEFAULT_ADBLOCK_RULES_JSON,
  resolveAdBlockRules,
  type CompileAdBlockRulesResult,
  type ResolvedAdBlockRules,
} from '../../modules/musubi-webview/src';
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from './fetch-utils';

const ADBLOCK_RULES_CACHE_FILENAME = 'musubi-adblock-rules.json';

export const DEFAULT_REMOTE_CATALOG_URL =
  'https://yusuke0627.github.io/MusubiReader/catalog/default-packs.json';

export const DEFAULT_REMOTE_ADBLOCK_RULES_URL =
  'https://yusuke0627.github.io/MusubiReader/adblock/default-rules.json';

export interface RemoteConfig {
  catalogUrl: string | null;
  adBlockRulesUrl: string | null;
}

export interface AdBlockRulesCacheStore {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
}

function normalizeHttpUrl(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string') {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveEnvOrDefaultUrl(
  rawEnvValue: string | undefined,
  defaultUrl: string
): string | null {
  if (rawEnvValue === undefined) {
    return defaultUrl;
  }
  const trimmed = rawEnvValue.trim();
  if (!trimmed || /^(off|disabled|none)$/i.test(trimmed)) {
    return null;
  }
  return normalizeHttpUrl(trimmed);
}

/**
 * Reads static JSON URLs from Expo public environment variables, defaulting to
 * the project's GitHub Pages endpoints when unset. Setting an env var to empty
 * or "off" explicitly disables remote fetching.
 * Direct `process.env.EXPO_PUBLIC_*` property access preserves Metro static inlining.
 */
export function getRemoteConfig(): RemoteConfig {
  return {
    catalogUrl: resolveEnvOrDefaultUrl(
      process.env.EXPO_PUBLIC_CATALOG_URL,
      DEFAULT_REMOTE_CATALOG_URL
    ),
    adBlockRulesUrl: resolveEnvOrDefaultUrl(
      process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL,
      DEFAULT_REMOTE_ADBLOCK_RULES_URL
    ),
  };
}

/**
 * Wraps `fetch` with `fetchWithTimeout` so remote JSON refreshes fail fast.
 */
export function createTimeoutFetcher(
  baseFetcher: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const targetUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return fetchWithTimeout(targetUrl, baseFetcher, timeoutMs);
  }) as typeof fetch;
}

async function resolveAdBlockCacheFile() {
  const { File, Paths } = await import('expo-file-system');
  const baseUri = Paths.document?.uri;
  if (!baseUri) {
    return null;
  }
  const fileUri = baseUri.endsWith('/')
    ? `${baseUri}${ADBLOCK_RULES_CACHE_FILENAME}`
    : `${baseUri}/${ADBLOCK_RULES_CACHE_FILENAME}`;
  return new File(fileUri);
}

/**
 * Persists validated remote ad-block rules JSON under `Paths.document` so offline
 * launches reuse the last valid remote ruleset before falling back to bundled defaults.
 */
export function createExpoAdBlockRulesCacheStore(): AdBlockRulesCacheStore {
  return {
    async read(): Promise<string | null> {
      try {
        const file = await resolveAdBlockCacheFile();
        if (!file || !file.exists) {
          return null;
        }
        return await file.text();
      } catch {
        return null;
      }
    },
    async write(json: string): Promise<void> {
      try {
        const file = await resolveAdBlockCacheFile();
        if (!file) {
          return;
        }
        const parent = file.parentDirectory;
        if (!parent.exists) {
          parent.create({ intermediates: true, idempotent: true });
        }
        file.create({ intermediates: true, overwrite: true });
        await file.write(json);
      } catch {
        // Ignore cache write errors; WKContentRuleListStore still caches compiled binary.
      }
    },
  };
}

export interface FetchAdBlockRulesOptions {
  url?: string | null;
  fetcher?: typeof fetch;
  cacheStore?: AdBlockRulesCacheStore;
  timeoutMs?: number;
}

/**
 * Fetches and validates remote WKContentRuleList JSON when `url` is configured,
 * caching valid remote rules and falling back to cached rules or `DEFAULT_ADBLOCK_RULES_JSON`.
 */
export async function fetchAndResolveAdBlockRules(
  options: FetchAdBlockRulesOptions = {}
): Promise<ResolvedAdBlockRules> {
  const url = normalizeHttpUrl(options.url ?? null);
  if (!url) {
    return { json: DEFAULT_ADBLOCK_RULES_JSON, usedFallback: true };
  }

  const fetcher = options.fetcher ?? fetch;
  const cacheStore = options.cacheStore ?? createExpoAdBlockRulesCacheStore();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  try {
    const response = await fetchWithTimeout(url, fetcher, timeoutMs);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const rawText = await response.text();
    const resolved = resolveAdBlockRules(rawText);
    if (!resolved.usedFallback) {
      await cacheStore.write(resolved.json);
      return resolved;
    }
  } catch {
    // Fall back to locally cached remote rules or bundled defaults below.
  }

  const cachedJson = await cacheStore.read().catch(() => null);
  if (cachedJson) {
    const cachedResolved = resolveAdBlockRules(cachedJson);
    if (!cachedResolved.usedFallback) {
      return cachedResolved;
    }
  }

  return { json: DEFAULT_ADBLOCK_RULES_JSON, usedFallback: true };
}

/**
 * Resolves remote/cached/default ad-block rules and compiles them once via `compileAdBlockRules`.
 */
export async function syncAndCompileAdBlockRules(
  options: FetchAdBlockRulesOptions = {}
): Promise<CompileAdBlockRulesResult> {
  const resolved = await fetchAndResolveAdBlockRules(options);
  return compileAdBlockRules(resolved.json);
}
