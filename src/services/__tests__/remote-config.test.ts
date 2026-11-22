import { DEFAULT_ADBLOCK_RULES_JSON } from '../../../modules/musubi-webview/src';
import {
  fetchAndResolveAdBlockRules,
  getRemoteConfig,
  syncAndCompileAdBlockRules,
  type AdBlockRulesCacheStore,
} from '../remote-config';

describe('remote-config', () => {
  const originalCatalogUrl = process.env.EXPO_PUBLIC_CATALOG_URL;
  const originalAdBlockUrl = process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL;

  afterEach(() => {
    if (originalCatalogUrl === undefined) {
      delete process.env.EXPO_PUBLIC_CATALOG_URL;
    } else {
      process.env.EXPO_PUBLIC_CATALOG_URL = originalCatalogUrl;
    }

    if (originalAdBlockUrl === undefined) {
      delete process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL;
    } else {
      process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL = originalAdBlockUrl;
    }
  });

  test('getRemoteConfig validates optional EXPO_PUBLIC_* URLs and ignores blank or non-HTTP(S) values', () => {
    delete process.env.EXPO_PUBLIC_CATALOG_URL;
    delete process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL;
    expect(getRemoteConfig()).toEqual({
      catalogUrl: null,
      adBlockRulesUrl: null,
    });

    process.env.EXPO_PUBLIC_CATALOG_URL = '   ';
    process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL = 'javascript:alert(1)';
    expect(getRemoteConfig()).toEqual({
      catalogUrl: null,
      adBlockRulesUrl: null,
    });

    process.env.EXPO_PUBLIC_CATALOG_URL = ' https://cdn.example.com/catalog.json ';
    process.env.EXPO_PUBLIC_ADBLOCK_RULES_URL = 'http://localhost:8080/rules.json';
    expect(getRemoteConfig()).toEqual({
      catalogUrl: 'https://cdn.example.com/catalog.json',
      adBlockRulesUrl: 'http://localhost:8080/rules.json',
    });
  });

  test('fetchAndResolveAdBlockRules skips network when unconfigured and caches valid remote rules', async () => {
    let cachedValue: string | null = null;
    const cacheStore: AdBlockRulesCacheStore = {
      async read() {
        return cachedValue;
      },
      async write(json: string) {
        cachedValue = json;
      },
    };
    const fetchSpy = jest.fn();

    const unconfigured = await fetchAndResolveAdBlockRules({
      url: null,
      fetcher: fetchSpy as unknown as typeof fetch,
      cacheStore,
    });
    expect(unconfigured).toEqual({
      json: DEFAULT_ADBLOCK_RULES_JSON,
      usedFallback: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const remoteRulesJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://tracker\\.example\\.jp/' },
        action: { type: 'block' },
      },
    ]);
    const okFetcher: typeof fetch = async () =>
      new Response(remoteRulesJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const fetched = await fetchAndResolveAdBlockRules({
      url: 'https://cdn.example.com/adblock.json',
      fetcher: okFetcher,
      cacheStore,
    });
    expect(fetched).toEqual({
      json: remoteRulesJson,
      usedFallback: false,
    });
    expect(cachedValue).toBe(remoteRulesJson);
  });

  test('fetchAndResolveAdBlockRules falls back to cached remote rules first, then DEFAULT_ADBLOCK_RULES_JSON', async () => {
    const validCachedJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://cached-ad\\.example\\.com/' },
        action: { type: 'block' },
      },
    ]);
    const cacheStoreWithData: AdBlockRulesCacheStore = {
      async read() {
        return validCachedJson;
      },
      async write() {},
    };
    const failingFetcher: typeof fetch = async () => {
      throw new Error('Offline');
    };

    await expect(
      fetchAndResolveAdBlockRules({
        url: 'https://cdn.example.com/adblock.json',
        fetcher: failingFetcher,
        cacheStore: cacheStoreWithData,
      })
    ).resolves.toEqual({
      json: validCachedJson,
      usedFallback: false,
    });

    const emptyCacheStore: AdBlockRulesCacheStore = {
      async read() {
        return null;
      },
      async write() {},
    };
    const invalidJsonFetcher: typeof fetch = async () =>
      new Response('{"not":"an-array"}', { status: 200 });

    await expect(
      fetchAndResolveAdBlockRules({
        url: 'https://cdn.example.com/adblock.json',
        fetcher: invalidJsonFetcher,
        cacheStore: emptyCacheStore,
      })
    ).resolves.toEqual({
      json: DEFAULT_ADBLOCK_RULES_JSON,
      usedFallback: true,
    });
  });

  test('syncAndCompileAdBlockRules compiles fetched remote rules via native MusubiWebView module', async () => {
    const remoteRulesJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://ads\\.example\\.net/' },
        action: { type: 'block' },
      },
    ]);
    const nativeCompile = jest.fn(async () => ({
      compiled: true,
      usedFallback: false,
    }));
    const expoObj = (
      globalThis as { expo?: { modules?: Record<string, unknown> } }
    ).expo;
    const prev = expoObj?.modules?.MusubiWebView;
    if (expoObj?.modules) {
      expoObj.modules.MusubiWebView = { compileAdBlockRules: nativeCompile };
    }

    try {
      const result = await syncAndCompileAdBlockRules({
        url: 'https://cdn.example.com/rules.json',
        fetcher: async () => new Response(remoteRulesJson, { status: 200 }),
        cacheStore: { read: async () => null, write: async () => {} },
      });
      expect(result).toEqual({ compiled: true, usedFallback: false });
      expect(nativeCompile).toHaveBeenCalledTimes(1);
      expect(nativeCompile).toHaveBeenCalledWith(
        remoteRulesJson,
        DEFAULT_ADBLOCK_RULES_JSON
      );
    } finally {
      if (expoObj?.modules) {
        if (prev === undefined) {
          delete expoObj.modules.MusubiWebView;
        } else {
          expoObj.modules.MusubiWebView = prev;
        }
      }
    }
  });
});
