import defaultRules from '../../../assets/adblock/default-rules.json';
import {
  type CompileAdBlockRulesResult,
  getMusubiWebViewNativeModule,
} from './MusubiWebView';

export {
  isHttpUrl,
  MusubiWebView,
  type CompileAdBlockRulesResult,
  type MusubiWebViewLoadEndEvent,
  type MusubiWebViewLoadStartEvent,
  type MusubiWebViewNativeModule,
  type MusubiWebViewProps,
} from './MusubiWebView';

export const DEFAULT_ADBLOCK_RULES_JSON: string = JSON.stringify(defaultRules);

const VALID_ACTION_TYPES = new Set([
  'block',
  'block-cookies',
  'css-display-none',
  'ignore-previous-rules',
  'make-https',
]);

interface ContentRuleLike {
  trigger?: {
    'url-filter'?: unknown;
  };
  action?: {
    type?: unknown;
    selector?: unknown;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidContentRule(entry: unknown): boolean {
  if (!isPlainObject(entry)) {
    return false;
  }

  const rule = entry as ContentRuleLike;
  if (!isPlainObject(rule.trigger) || !isPlainObject(rule.action)) {
    return false;
  }

  const urlFilter = rule.trigger['url-filter'];
  if (typeof urlFilter !== 'string' || urlFilter.length === 0) {
    return false;
  }

  const actionType = rule.action.type;
  if (typeof actionType !== 'string' || !VALID_ACTION_TYPES.has(actionType)) {
    return false;
  }

  if (actionType === 'css-display-none') {
    const selector = rule.action.selector;
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      return false;
    }
  }

  return true;
}

export interface ResolvedAdBlockRules {
  json: string;
  usedFallback: boolean;
}

/**
 * Validates a WKContentRuleList JSON array string and falls back to the bundled
 * `assets/adblock/default-rules.json` when null, empty, or malformed.
 */
export function resolveAdBlockRules(remoteJson: string | null): ResolvedAdBlockRules {
  if (typeof remoteJson !== 'string' || remoteJson.trim().length === 0) {
    return { json: DEFAULT_ADBLOCK_RULES_JSON, usedFallback: true };
  }

  try {
    const parsed: unknown = JSON.parse(remoteJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { json: DEFAULT_ADBLOCK_RULES_JSON, usedFallback: true };
    }
    if (!parsed.every(isValidContentRule)) {
      return { json: DEFAULT_ADBLOCK_RULES_JSON, usedFallback: true };
    }
    return { json: remoteJson, usedFallback: false };
  } catch {
    return { json: DEFAULT_ADBLOCK_RULES_JSON, usedFallback: true };
  }
}

export function resolveAdBlockRulesJson(remoteJson: string | null): string {
  return resolveAdBlockRules(remoteJson).json;
}

/**
 * Compiles WKContentRuleList rules on iOS via `MusubiWebViewModule`, automatically
 * falling back to bundled default rules if the input or native compilation fails.
 */
export async function compileAdBlockRules(
  rulesJson: string | null = DEFAULT_ADBLOCK_RULES_JSON
): Promise<CompileAdBlockRulesResult> {
  const resolved = resolveAdBlockRules(rulesJson);
  const nativeModule = getMusubiWebViewNativeModule();
  if (!nativeModule) {
    return {
      compiled: false,
      usedFallback: resolved.usedFallback,
    };
  }

  try {
    const result = await nativeModule.compileAdBlockRules(
      resolved.json,
      DEFAULT_ADBLOCK_RULES_JSON
    );
    return {
      compiled: Boolean(result?.compiled),
      usedFallback: resolved.usedFallback || Boolean(result?.usedFallback),
    };
  } catch {
    if (!resolved.usedFallback) {
      try {
        const fallbackResult = await nativeModule.compileAdBlockRules(
          DEFAULT_ADBLOCK_RULES_JSON,
          null
        );
        return {
          compiled: Boolean(fallbackResult?.compiled),
          usedFallback: true,
        };
      } catch {
        return { compiled: false, usedFallback: true };
      }
    }
    return {
      compiled: false,
      usedFallback: true,
    };
  }
}
