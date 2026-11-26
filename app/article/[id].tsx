import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  type NativeSyntheticEvent,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isHttpUrl,
  MusubiWebView,
  type MusubiWebViewAutoScrollEvent,
  type MusubiWebViewLoadEndEvent,
} from '../../modules/musubi-webview/src';
import type { Article } from '../../src/domain/types';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

export const AUTO_SCROLL_SPEED_PRESETS = [
  { label: '0.5x', pointsPerSecond: 22 },
  { label: '1.0x', pointsPerSecond: 40 },
  { label: '1.5x', pointsPerSecond: 62 },
  { label: '2.0x', pointsPerSecond: 88 },
  { label: '2.5x', pointsPerSecond: 120 },
] as const;

let lastAutoScrollSpeedIndex = 1;

function normalizeParamId(rawId: string | string[] | undefined): string {
  const value = Array.isArray(rawId) ? rawId[0] : rawId;
  return typeof value === 'string' ? value.trim() : '';
}

export default function ArticleReaderScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const articleId = normalizeParamId(params.id);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  const {
    isReady,
    initError,
    getArticleById,
    getCacheEntry,
    recordArticleRead,
    recordBlockedAds,
    toggleSaved,
  } = useAppData();

  const [article, setArticle] = useState<Article | null>(null);
  const [offlineHtmlPath, setOfflineHtmlPath] = useState<string | null>(null);
  const [isLoadingArticle, setIsLoadingArticle] = useState(true);
  const [isLoadingWebView, setIsLoadingWebView] = useState(false);
  const [usedOfflineFallback, setUsedOfflineFallback] = useState(false);
  const [preferCache, setPreferCache] = useState(true);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [blockedCount, setBlockedCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isTogglingSave, setIsTogglingSave] = useState(false);
  const [isAutoScrolling, setIsAutoScrolling] = useState(false);
  const [autoScrollSpeedIndex, setAutoScrollSpeedIndex] = useState(
    lastAutoScrollSpeedIndex
  );

  const currentSpeedPreset =
    AUTO_SCROLL_SPEED_PRESETS[autoScrollSpeedIndex] ??
    AUTO_SCROLL_SPEED_PRESETS[1];

  useEffect(() => {
    setIsAutoScrolling(false);
  }, [articleId]);

  const handleToggleAutoScroll = useCallback(() => {
    setIsAutoScrolling((prev) => !prev);
  }, []);

  const handleChangeAutoScrollSpeed = useCallback((delta: -1 | 1) => {
    setAutoScrollSpeedIndex((prev) => {
      const next = Math.max(
        0,
        Math.min(AUTO_SCROLL_SPEED_PRESETS.length - 1, prev + delta)
      );
      lastAutoScrollSpeedIndex = next;
      return next;
    });
  }, []);

  const handleAutoScrollStateChange = useCallback(
    (event: NativeSyntheticEvent<MusubiWebViewAutoScrollEvent>) => {
      if (!event.nativeEvent.isScrolling) {
        setIsAutoScrolling(false);
      }
    },
    []
  );

  const recordedArticleIdRef = useRef<string | null>(null);
  const recordedBlockedArticleIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const activeArticleIdRef = useRef(articleId);
  activeArticleIdRef.current = articleId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (initError || !articleId) {
      setArticle(null);
      setOfflineHtmlPath(null);
      setIsLoadingArticle(false);
      return;
    }

    let cancelled = false;
    setIsLoadingArticle(true);
    setIsLoadingWebView(false);
    setUsedOfflineFallback(false);
    setLoadError(null);

    (async () => {
      try {
        const [loadedArticle, cacheEntry] = await Promise.all([
          getArticleById(articleId),
          getCacheEntry(articleId),
        ]);
        if (cancelled) {
          return;
        }
        setArticle(loadedArticle);
        setOfflineHtmlPath(cacheEntry?.localPath ?? null);
        setIsLoadingArticle(false);

        if (loadedArticle && recordedArticleIdRef.current !== loadedArticle.id) {
          recordedArticleIdRef.current = loadedArticle.id;
          void recordArticleRead(loadedArticle.id, loadedArticle.category).catch(
            () => {}
          );
        }
      } catch {
        if (!cancelled) {
          setArticle(null);
          setOfflineHtmlPath(null);
          setIsLoadingArticle(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isReady,
    initError,
    articleId,
    getArticleById,
    getCacheEntry,
    recordArticleRead,
  ]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleToggleSave = useCallback(async () => {
    if (!article || isTogglingSave) {
      return;
    }
    const targetId = article.id;
    setIsTogglingSave(true);
    try {
      await toggleSaved(targetId);
      const refreshed = await getArticleById(targetId);
      if (
        mountedRef.current &&
        activeArticleIdRef.current === targetId &&
        refreshed
      ) {
        setArticle(refreshed);
      }
    } catch {
      // Ignore concurrent purge or storage errors without leaving unhandled rejections.
    } finally {
      if (mountedRef.current) {
        setIsTogglingSave(false);
      }
    }
  }, [article, isTogglingSave, toggleSaved, getArticleById]);

  const handleShare = useCallback(async () => {
    if (!article) {
      return;
    }
    try {
      await Share.share({
        title: article.title,
        message: article.title,
        url: article.url,
      });
    } catch {
      // Ignore share cancellation or platform share failure.
    }
  }, [article]);

  const handleOpenInSafari = useCallback(async () => {
    if (!article || !isHttpUrl(article.url)) {
      return;
    }
    try {
      await Linking.openURL(article.url);
    } catch {
      // Ignore external open failures.
    }
  }, [article]);

  const handleLoadStart = useCallback(() => {
    setIsLoadingWebView(true);
    setLoadError(null);
  }, []);

  const handleLoadEnd = useCallback(
    (event: NativeSyntheticEvent<MusubiWebViewLoadEndEvent>) => {
      const payload = event.nativeEvent;
      setIsLoadingWebView(false);
      setUsedOfflineFallback(Boolean(payload.usedOfflineFallback));
      setLastDurationMs(
        typeof payload.durationMs === 'number' ? payload.durationMs : null
      );
      if (typeof payload.blockedCount === 'number') {
        setBlockedCount(payload.blockedCount);
        const currentId = activeArticleIdRef.current;
        if (
          payload.blockedCount > 0 &&
          currentId &&
          recordedBlockedArticleIdRef.current !== currentId
        ) {
          recordedBlockedArticleIdRef.current = currentId;
          void recordBlockedAds(payload.blockedCount);
        }
      }
      if (!payload.success && payload.error) {
        setLoadError(payload.error);
      } else {
        setLoadError(null);
      }
    },
    [recordBlockedAds]
  );

  const renderToolbar = (showArticleActions: boolean) => (
    <View
      style={[
        styles.toolbar,
        {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom, 10),
        },
      ]}
    >
      <Pressable
        testID="reader-back-button"
        accessibilityRole="button"
        onPress={handleBack}
        style={[
          styles.toolbarBtn,
          showArticleActions ? styles.toolbarBtnCompact : styles.toolbarBtnFull,
          { backgroundColor: colors.surfaceSecondary },
        ]}
      >
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
          style={[styles.toolbarBtnText, { color: colors.text }]}
        >
          戻る
        </Text>
      </Pressable>

      {showArticleActions && article ? (
        <>
          <Pressable
            testID="reader-save-button"
            accessibilityRole="button"
            disabled={isTogglingSave}
            onPress={() => void handleToggleSave()}
            style={[
              styles.toolbarBtn,
              styles.toolbarBtnWide,
              {
                backgroundColor: article.isSaved
                  ? colors.badgeSavedBg
                  : colors.accentSoft,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={[
                styles.toolbarBtnText,
                {
                  color: article.isSaved
                    ? colors.badgeSavedText
                    : colors.accentText,
                },
              ]}
            >
              {article.isSaved ? '★ ブックマーク済み' : '☆ ブックマーク'}
            </Text>
          </Pressable>

          <Pressable
            testID="reader-share-button"
            accessibilityRole="button"
            onPress={() => void handleShare()}
            style={[
              styles.toolbarBtn,
              styles.toolbarBtnCompact,
              { backgroundColor: colors.surfaceSecondary },
            ]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={[styles.toolbarBtnText, { color: colors.text }]}
            >
              共有
            </Text>
          </Pressable>

          <Pressable
            testID="reader-safari-button"
            accessibilityRole="button"
            onPress={() => void handleOpenInSafari()}
            style={[
              styles.toolbarBtn,
              styles.toolbarBtnMedium,
              { backgroundColor: colors.surfaceSecondary },
            ]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={[styles.toolbarBtnText, { color: colors.text }]}
            >
              Safariで開く
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );

  if (!isReady || isLoadingArticle) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: '記事', headerBackTitle: '戻る' }} />
        <View style={styles.centerBox}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            記事を読み込み中です…
          </Text>
        </View>
        {renderToolbar(false)}
      </View>
    );
  }

  if (initError) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: '記事', headerBackTitle: '戻る' }} />
        <View style={styles.centerBox}>
          <Text style={[styles.centerTitle, { color: colors.danger }]}>
            データの読み込みに失敗しました
          </Text>
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            {initError}
          </Text>
        </View>
        {renderToolbar(false)}
      </View>
    );
  }

  if (!article) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: '記事', headerBackTitle: '戻る' }} />
        <View testID="reader-missing-article" style={styles.centerBox}>
          <Text style={[styles.centerTitle, { color: colors.text }]}>
            記事が見つかりませんでした
          </Text>
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            記事が削除されたか、まだ同期されていない可能性があります。
          </Text>
        </View>
        {renderToolbar(false)}
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: article.siteName || '記事',
          headerBackTitle: '戻る',
          headerTransparent: false,
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }}
      />

      {usedOfflineFallback ? (
        <View
          testID="reader-offline-indicator"
          style={[
            styles.statusBanner,
            styles.statusBannerWithAction,
            {
              backgroundColor: colors.badgeSuccessBg,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[
              styles.statusBannerText,
              styles.statusBannerTextFlex,
              { color: colors.badgeSuccessText },
            ]}
          >
            オフライン
            {lastDurationMs !== null ? `（${lastDurationMs}ms）` : ''}
            {blockedCount !== null && blockedCount > 0
              ? `・🛡️ ${blockedCount}件カット`
              : ''}
          </Text>
          <Pressable
            testID="reader-switch-online-button"
            accessibilityRole="button"
            onPress={() => setPreferCache(false)}
            style={[
              styles.bannerActionBtn,
              { backgroundColor: colors.surface },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.bannerActionText, { color: colors.text }]}
            >
              オンライン表示
            </Text>
          </Pressable>
        </View>
      ) : offlineHtmlPath && !preferCache ? (
        <View
          style={[
            styles.statusBanner,
            styles.statusBannerWithAction,
            {
              backgroundColor: colors.surfaceSecondary,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[
              styles.statusBannerText,
              styles.statusBannerTextFlex,
              { color: colors.textSecondary },
            ]}
          >
            オンライン
            {lastDurationMs !== null ? `（${lastDurationMs}ms）` : ''}
            {blockedCount !== null && blockedCount > 0
              ? `・🛡️ ${blockedCount}件カット`
              : ''}
          </Text>
          <Pressable
            testID="reader-switch-cache-button"
            accessibilityRole="button"
            onPress={() => setPreferCache(true)}
            style={[
              styles.bannerActionBtn,
              { backgroundColor: colors.badgeSuccessBg },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.bannerActionText,
                { color: colors.badgeSuccessText },
              ]}
            >
              キャッシュ表示
            </Text>
          </Pressable>
        </View>
      ) : blockedCount !== null && blockedCount > 0 ? (
        <View
          testID="reader-adblock-count-banner"
          style={[
            styles.statusBanner,
            {
              backgroundColor: colors.accentSoft,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.statusBannerText, { color: colors.accentText }]}>
            {`🛡️ 広告・不要要素 ${blockedCount}件カット`}
          </Text>
        </View>
      ) : null}

      {isLoadingWebView ? (
        <View
          style={[
            styles.statusBanner,
            {
              backgroundColor: colors.accentSoft,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <ActivityIndicator size="small" color={colors.accentText} />
          <Text style={[styles.statusBannerText, { color: colors.accentText }]}>
            ページを読み込み中…
          </Text>
        </View>
      ) : null}

      {loadError && !usedOfflineFallback ? (
        <View
          testID="reader-error-banner"
          style={[
            styles.statusBanner,
            {
              backgroundColor: colors.dangerSoft,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.statusBannerText, { color: colors.danger }]}>
            ページの読み込みに失敗しました（{loadError}）
          </Text>
        </View>
      ) : null}

      <View style={styles.webViewWrapper}>
        <MusubiWebView
          style={styles.webView}
          url={article.url}
          offlineHtmlPath={offlineHtmlPath}
          adBlockEnabled={true}
          preferOfflineCache={preferCache && Boolean(offlineHtmlPath)}
          autoScrollEnabled={isAutoScrolling}
          autoScrollSpeed={currentSpeedPreset.pointsPerSecond}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onAutoScrollStateChange={handleAutoScrollStateChange}
        />

        <View
          testID="reader-autoscroll-pill"
          style={[
            styles.autoScrollPill,
            {
              backgroundColor: isAutoScrolling
                ? colors.accent
                : colors.surface,
              borderColor: isAutoScrolling ? colors.accent : colors.border,
            },
          ]}
        >
          <Pressable
            testID="reader-autoscroll-toggle"
            accessibilityRole="button"
            accessibilityLabel={
              isAutoScrolling ? '自動スクロールを停止' : '自動スクロールを開始'
            }
            onPress={handleToggleAutoScroll}
            style={styles.autoScrollToggleBtn}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.autoScrollToggleText,
                { color: isAutoScrolling ? '#FFFFFF' : colors.text },
              ]}
            >
              {isAutoScrolling ? '⏸' : '▶ 自動'}
            </Text>
          </Pressable>

          {isAutoScrolling ? (
            <>
              <View style={styles.autoScrollDivider} />
              <Pressable
                testID="reader-autoscroll-slower"
                accessibilityRole="button"
                accessibilityLabel="スクロールを遅くする"
                disabled={autoScrollSpeedIndex <= 0}
                onPress={() => handleChangeAutoScrollSpeed(-1)}
                style={[
                  styles.autoScrollStepBtn,
                  autoScrollSpeedIndex <= 0 && styles.autoScrollStepDisabled,
                ]}
              >
                <Text style={styles.autoScrollStepText}>−</Text>
              </Pressable>
              <Text
                testID="reader-autoscroll-speed-label"
                style={styles.autoScrollSpeedText}
              >
                {currentSpeedPreset.label}
              </Text>
              <Pressable
                testID="reader-autoscroll-faster"
                accessibilityRole="button"
                accessibilityLabel="スクロールを速くする"
                disabled={
                  autoScrollSpeedIndex >= AUTO_SCROLL_SPEED_PRESETS.length - 1
                }
                onPress={() => handleChangeAutoScrollSpeed(1)}
                style={[
                  styles.autoScrollStepBtn,
                  autoScrollSpeedIndex >=
                    AUTO_SCROLL_SPEED_PRESETS.length - 1 &&
                    styles.autoScrollStepDisabled,
                ]}
              >
                <Text style={styles.autoScrollStepText}>＋</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>

      {renderToolbar(true)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webViewWrapper: {
    flex: 1,
    position: 'relative',
  },
  webView: {
    flex: 1,
  },
  autoScrollPill: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    minHeight: 38,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  autoScrollToggleBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoScrollToggleText: {
    fontSize: 13,
    fontWeight: '700',
  },
  autoScrollDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  autoScrollStepBtn: {
    minWidth: 32,
    paddingHorizontal: 8,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoScrollStepDisabled: {
    opacity: 0.4,
  },
  autoScrollStepText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  autoScrollSpeedText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    minWidth: 34,
    textAlign: 'center',
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusBannerWithAction: {
    justifyContent: 'space-between',
  },
  bannerActionBtn: {
    flexShrink: 0,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  bannerActionText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusBannerText: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  statusBannerTextFlex: {
    flex: 1,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 10,
  },
  centerTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  centerText: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toolbarBtn: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  toolbarBtnFull: {
    flex: 1,
  },
  toolbarBtnCompact: {
    flex: 0.75,
  },
  toolbarBtnMedium: {
    flex: 1.15,
  },
  toolbarBtnWide: {
    flex: 1.65,
  },
  toolbarBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
