import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { CSSProperties, JSX } from 'react';
import { useEffect, useRef } from 'react';
import {
  Linking,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewProps,
} from 'react-native';

export interface MusubiWebViewLoadStartEvent {
  url: string;
}

export interface MusubiWebViewLoadEndEvent {
  url: string;
  success: boolean;
  usedOfflineFallback: boolean;
  error?: string;
}

export interface CompileAdBlockRulesResult {
  compiled: boolean;
  usedFallback: boolean;
}

export interface MusubiWebViewNativeModule {
  compileAdBlockRules(
    rulesJson: string,
    fallbackRulesJson?: string | null
  ): Promise<CompileAdBlockRulesResult>;
}

export interface MusubiWebViewProps extends ViewProps {
  url: string;
  offlineHtmlPath?: string | null;
  adBlockEnabled?: boolean;
  onLoadStart?: (event: NativeSyntheticEvent<MusubiWebViewLoadStartEvent>) => void;
  onLoadEnd?: (event: NativeSyntheticEvent<MusubiWebViewLoadEndEvent>) => void;
}

interface NativeMusubiWebViewProps extends ViewProps {
  url: string;
  offlineHtmlPath: string | null;
  adBlockEnabled: boolean;
  onLoadStart?: (event: NativeSyntheticEvent<MusubiWebViewLoadStartEvent>) => void;
  onLoadEnd?: (event: NativeSyntheticEvent<MusubiWebViewLoadEndEvent>) => void;
}

const WEB_IFRAME_STYLE: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  flex: 1,
};

let cachedNativeView: React.ComponentType<NativeMusubiWebViewProps> | null | undefined;

export function getMusubiWebViewNativeModule(): MusubiWebViewNativeModule | null {
  return requireOptionalNativeModule<MusubiWebViewNativeModule>('MusubiWebView');
}

function getNativeWebView(): React.ComponentType<NativeMusubiWebViewProps> | null {
  if (Platform.OS !== 'ios') {
    return null;
  }
  if (cachedNativeView !== undefined) {
    return cachedNativeView;
  }
  if (!getMusubiWebViewNativeModule()) {
    cachedNativeView = null;
    return null;
  }
  try {
    cachedNativeView = requireNativeView<NativeMusubiWebViewProps>('MusubiWebView');
  } catch {
    cachedNativeView = null;
  }
  return cachedNativeView;
}

export function isHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function createSyntheticEvent<T>(nativeEvent: T): NativeSyntheticEvent<T> {
  return { nativeEvent } as NativeSyntheticEvent<T>;
}

export function MusubiWebView({
  url,
  offlineHtmlPath = null,
  adBlockEnabled = true,
  onLoadStart,
  onLoadEnd,
  style,
  ...viewProps
}: MusubiWebViewProps): JSX.Element {
  const nativeWebView = getNativeWebView();
  const safeUrl = isHttpUrl(url);

  const onLoadStartRef = useRef(onLoadStart);
  const onLoadEndRef = useRef(onLoadEnd);
  onLoadStartRef.current = onLoadStart;
  onLoadEndRef.current = onLoadEnd;

  useEffect(() => {
    if (Platform.OS !== 'web' || !safeUrl) {
      return;
    }
    onLoadStartRef.current?.(createSyntheticEvent({ url }));
  }, [safeUrl, url]);

  if (nativeWebView) {
    const NativeWebView = nativeWebView;
    return (
      <NativeWebView
        {...viewProps}
        style={[styles.fill, style]}
        url={url}
        offlineHtmlPath={offlineHtmlPath ?? null}
        adBlockEnabled={adBlockEnabled}
        onLoadStart={onLoadStart}
        onLoadEnd={onLoadEnd}
      />
    );
  }

  if (Platform.OS === 'web') {
    return (
      <View {...viewProps} style={[styles.webContainer, style]}>
        {safeUrl ? (
          <iframe
            src={url}
            title={url}
            style={WEB_IFRAME_STYLE}
            sandbox="allow-scripts allow-same-origin allow-popups"
            onLoad={() => {
              onLoadEndRef.current?.(
                createSyntheticEvent({
                  url,
                  success: true,
                  usedOfflineFallback: false,
                })
              );
            }}
          />
        ) : (
          <View style={styles.fallbackContainer}>
            <Text style={styles.fallbackTitle}>記事URLを表示できません</Text>
            <Text style={styles.fallbackMeta}>{url}</Text>
          </View>
        )}
        {safeUrl ? (
          <View style={styles.webLinkBar}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 13, color: '#0a7ea4', textDecoration: 'none' }}
            >
              新しいタブで開く
            </a>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View {...viewProps} style={[styles.fallbackContainer, style]}>
      <Text style={styles.fallbackTitle}>
        {offlineHtmlPath ? 'オフラインキャッシュが利用可能です' : 'ブラウザで記事を開く'}
      </Text>
      <Text style={styles.fallbackMeta} numberOfLines={2}>
        {url}
      </Text>
      {safeUrl ? (
        <Pressable
          accessibilityRole="button"
          style={styles.fallbackButton}
          onPress={() => {
            void Linking.openURL(url);
          }}
        >
          <Text style={styles.fallbackButtonLabel}>外部ブラウザで開く</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  webContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webLinkBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0',
    alignItems: 'flex-end',
  },
  fallbackContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 12,
    backgroundColor: '#f8fafc',
  },
  fallbackTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a',
    textAlign: 'center',
  },
  fallbackMeta: {
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
  },
  fallbackButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#0a7ea4',
  },
  fallbackButtonLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
});
