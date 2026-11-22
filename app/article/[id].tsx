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
  type MusubiWebViewLoadEndEvent,
} from '../../modules/musubi-webview/src';
import type { Article } from '../../src/domain/types';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

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
    toggleSaved,
  } = useAppData();

  const [article, setArticle] = useState<Article | null>(null);
  const [offlineHtmlPath, setOfflineHtmlPath] = useState<string | null>(null);
  const [isLoadingArticle, setIsLoadingArticle] = useState(true);
  const [isLoadingWebView, setIsLoadingWebView] = useState(false);
  const [usedOfflineFallback, setUsedOfflineFallback] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isTogglingSave, setIsTogglingSave] = useState(false);

  const recordedArticleIdRef = useRef<string | null>(null);
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
      if (!payload.success && payload.error) {
        setLoadError(payload.error);
      } else {
        setLoadError(null);
      }
    },
    []
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
        style={[styles.toolbarBtn, { backgroundColor: colors.surfaceSecondary }]}
      >
        <Text style={[styles.toolbarBtnText, { color: colors.text }]}>
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
              {
                backgroundColor: article.isSaved
                  ? colors.badgeSavedBg
                  : colors.accentSoft,
              },
            ]}
          >
            <Text
              style={[
                styles.toolbarBtnText,
                {
                  color: article.isSaved
                    ? colors.badgeSavedText
                    : colors.accentText,
                },
              ]}
            >
              {article.isSaved ? '保存済み' : '後で読む'}
            </Text>
          </Pressable>

          <Pressable
            testID="reader-share-button"
            accessibilityRole="button"
            onPress={() => void handleShare()}
            style={[
              styles.toolbarBtn,
              { backgroundColor: colors.surfaceSecondary },
            ]}
          >
            <Text style={[styles.toolbarBtnText, { color: colors.text }]}>
              共有
            </Text>
          </Pressable>

          <Pressable
            testID="reader-safari-button"
            accessibilityRole="button"
            onPress={() => void handleOpenInSafari()}
            style={[
              styles.toolbarBtn,
              { backgroundColor: colors.surfaceSecondary },
            ]}
          >
            <Text style={[styles.toolbarBtnText, { color: colors.text }]}>
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
        }}
      />

      {usedOfflineFallback ? (
        <View
          testID="reader-offline-indicator"
          style={[
            styles.statusBanner,
            {
              backgroundColor: colors.badgeSuccessBg,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text
            style={[styles.statusBannerText, { color: colors.badgeSuccessText }]}
          >
            オフラインキャッシュを表示中
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

      <MusubiWebView
        style={styles.webView}
        url={article.url}
        offlineHtmlPath={offlineHtmlPath}
        adBlockEnabled={true}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
      />

      {renderToolbar(true)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webView: {
    flex: 1,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusBannerText: {
    fontSize: 12,
    fontWeight: '600',
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
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toolbarBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  toolbarBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
