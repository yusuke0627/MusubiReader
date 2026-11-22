import defaultRules from '../../../assets/adblock/default-rules.json';
import {
  compileAdBlockRules,
  DEFAULT_ADBLOCK_RULES_JSON,
  MusubiWebView,
  resolveAdBlockRulesJson,
} from '../src';
import { isHttpUrl } from '../src/MusubiWebView';

describe('resolveAdBlockRulesJson', () => {
  const expectedDefaultJson = JSON.stringify(defaultRules);

  test('falls back to bundled default rules when remoteJson is null or blank', () => {
    expect(resolveAdBlockRulesJson(null)).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('   \n\t  ')).toBe(expectedDefaultJson);
    expect(DEFAULT_ADBLOCK_RULES_JSON).toBe(expectedDefaultJson);
  });

  test('falls back to bundled default rules when remoteJson is malformed JSON', () => {
    expect(resolveAdBlockRulesJson('{not valid json')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('[{"trigger":')).toBe(expectedDefaultJson);
  });

  test('falls back to bundled default rules when remoteJson is not a non-empty rule array', () => {
    expect(resolveAdBlockRulesJson('{}')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('123')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('"string"')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('null')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('[]')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('[null]')).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson('["not-an-object"]')).toBe(expectedDefaultJson);
  });

  test('falls back when rule entries violate WKContentRuleList trigger/action schema', () => {
    const missingUrlFilter = JSON.stringify([
      { trigger: {}, action: { type: 'block' } },
    ]);
    const emptyUrlFilter = JSON.stringify([
      { trigger: { 'url-filter': '' }, action: { type: 'block' } },
    ]);
    const unknownActionType = JSON.stringify([
      { trigger: { 'url-filter': '^https://ads\\.example/' }, action: { type: 'allow' } },
    ]);
    const missingSelector = JSON.stringify([
      { trigger: { 'url-filter': '^https://.*' }, action: { type: 'css-display-none' } },
    ]);

    expect(resolveAdBlockRulesJson(missingUrlFilter)).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson(emptyUrlFilter)).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson(unknownActionType)).toBe(expectedDefaultJson);
    expect(resolveAdBlockRulesJson(missingSelector)).toBe(expectedDefaultJson);
  });

  test('returns remoteJson verbatim when it is a valid WKContentRuleList array', () => {
    const validRemoteJson = JSON.stringify([
      {
        trigger: {
          'url-filter': '^https?://([^/]+\\.)?ads\\.example\\.jp/',
          'load-type': ['third-party'],
        },
        action: { type: 'block' },
      },
      {
        trigger: {
          'url-filter': '^https?://.*',
        },
        action: {
          type: 'css-display-none',
          selector: '.sponsored-banner',
        },
      },
    ]);

    expect(resolveAdBlockRulesJson(validRemoteJson)).toBe(validRemoteJson);
  });
});

describe('compileAdBlockRules', () => {
  const originalMusubiModule = (
    globalThis as { expo?: { modules?: Record<string, unknown> } }
  ).expo?.modules?.MusubiWebView;

  afterEach(() => {
    const expoModules = (
      globalThis as { expo?: { modules?: Record<string, unknown> } }
    ).expo?.modules;
    if (expoModules) {
      if (originalMusubiModule === undefined) {
        delete expoModules.MusubiWebView;
      } else {
        expoModules.MusubiWebView = originalMusubiModule;
      }
    }
  });

  test('reports uncompiled and fallback status cleanly when native module is absent in Jest/Web', async () => {
    const validRemoteJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://ads\\.example\\.com/' },
        action: { type: 'block' },
      },
    ]);

    await expect(compileAdBlockRules(validRemoteJson)).resolves.toEqual({
      compiled: false,
      usedFallback: false,
    });

    await expect(compileAdBlockRules('{malformed')).resolves.toEqual({
      compiled: false,
      usedFallback: true,
    });
  });

  test('compiles valid remote rules via native module without fallback', async () => {
    const validRemoteJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://ads\\.example\\.com/' },
        action: { type: 'block' },
      },
    ]);
    const nativeCompile = jest.fn(async () => ({
      compiled: true,
      usedFallback: false,
    }));
    (globalThis as { expo: { modules: Record<string, unknown> } }).expo.modules.MusubiWebView = {
      compileAdBlockRules: nativeCompile,
    };

    await expect(compileAdBlockRules(validRemoteJson)).resolves.toEqual({
      compiled: true,
      usedFallback: false,
    });
    expect(nativeCompile).toHaveBeenCalledWith(
      validRemoteJson,
      DEFAULT_ADBLOCK_RULES_JSON
    );
  });

  test('marks usedFallback when remote JSON fails JS validation or native WebKit compilation', async () => {
    const nativeCompile = jest
      .fn()
      .mockResolvedValueOnce({ compiled: true, usedFallback: false })
      .mockResolvedValueOnce({ compiled: true, usedFallback: true });
    (globalThis as { expo: { modules: Record<string, unknown> } }).expo.modules.MusubiWebView = {
      compileAdBlockRules: nativeCompile,
    };

    await expect(compileAdBlockRules('not-json')).resolves.toEqual({
      compiled: true,
      usedFallback: true,
    });
    expect(nativeCompile).toHaveBeenNthCalledWith(
      1,
      DEFAULT_ADBLOCK_RULES_JSON,
      DEFAULT_ADBLOCK_RULES_JSON
    );

    const regexBrokenRules = JSON.stringify([
      {
        trigger: { 'url-filter': '[unclosed-regex' },
        action: { type: 'block' },
      },
    ]);
    await expect(compileAdBlockRules(regexBrokenRules)).resolves.toEqual({
      compiled: true,
      usedFallback: true,
    });
  });

  test('retries with bundled default rules if native module rejects primary call', async () => {
    const validRemoteJson = JSON.stringify([
      {
        trigger: { 'url-filter': '^https?://ads\\.example\\.com/' },
        action: { type: 'block' },
      },
    ]);
    const nativeCompile = jest
      .fn()
      .mockRejectedValueOnce(new Error('WebKit compiler failed'))
      .mockResolvedValueOnce({ compiled: true, usedFallback: false });
    (globalThis as { expo: { modules: Record<string, unknown> } }).expo.modules.MusubiWebView = {
      compileAdBlockRules: nativeCompile,
    };

    await expect(compileAdBlockRules(validRemoteJson)).resolves.toEqual({
      compiled: true,
      usedFallback: true,
    });
    expect(nativeCompile).toHaveBeenNthCalledWith(
      2,
      DEFAULT_ADBLOCK_RULES_JSON,
      null
    );
  });

  test('exports MusubiWebView component and validates safe HTTP(S) URLs', () => {
    expect(typeof MusubiWebView).toBe('function');
    expect(isHttpUrl('https://example.com/article/1')).toBe(true);
    expect(isHttpUrl('http://example.com/article/1')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});
