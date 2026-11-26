import { type Href, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ArticleRow } from '../../src/components/ArticleRow';
import { ALL_CATEGORIES, CategoryBar } from '../../src/components/CategoryBar';
import { PackSwitcher, type PackTabItem } from '../../src/components/PackSwitcher';
import { PREFETCH_BATCH_SIZE_OPTIONS } from '../../src/data/repositories/settings-repository';
import { MY_RSS_PACK_ID } from '../../src/domain/catalog-merge';
import type { Article } from '../../src/domain/types';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

const PREFETCH_BATCH_DESCRIPTIONS: Record<number, string> = {
  10: 'サクッと短時間',
  20: 'ちょい外出',
  30: 'バランス',
  50: '半日のお出かけ',
  100: '長時間・ガッツリ',
};

export default function HomeScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const {
    isReady,
    initError,
    catalog,
    resolvedFeeds,
    packSettings,
    customFeeds,
    cacheEntries,
    networkState,
    isSyncing,
    isPrefetching,
    lastPrefetchResult,
    prefetchBatchSize,
    dataVersion,
    syncNow,
    syncAndPrefetchNow,
    cancelSyncAndPrefetch,
    setPrefetchBatchSize,
    listArticlesByPackAndCategory,
    toggleSaved,
    muteSite,
  } = useAppData();

  const availablePacks = useMemo<PackTabItem[]>(() => {
    if (!catalog) {
      return [];
    }
    const settingMap = new Map(packSettings.map((s) => [s.packId, s.enabled]));
    const items: PackTabItem[] = [];

    for (const pack of catalog.packs) {
      const enabled = settingMap.get(pack.packId) ?? pack.defaultEnabled;
      if (enabled) {
        items.push({ packId: pack.packId, name: pack.name });
      }
    }

    const myRssEnabled = settingMap.get(MY_RSS_PACK_ID) ?? true;
    if (myRssEnabled) {
      items.push({ packId: MY_RSS_PACK_ID, name: 'マイRSS' });
    }

    return items;
  }, [catalog, packSettings]);

  const [selectedPackId, setSelectedPackId] = useState<string>('matome-5ch');
  const [selectedCategory, setSelectedCategory] =
    useState<string>(ALL_CATEGORIES);
  const [articles, setArticles] = useState<Article[]>([]);
  const [isLoadingArticles, setIsLoadingArticles] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [isCountPickerOpen, setIsCountPickerOpen] = useState(false);
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const manualFilterOverrideRef = useRef<boolean | null>(null);
  const lastNetworkTypeRef = useRef<string | undefined>(undefined);

  const cachedIdSet = useMemo(
    () => new Set(cacheEntries.map((entry) => entry.articleId)),
    [cacheEntries]
  );

  const isNonWifi = Boolean(networkState) && networkState?.type !== 'WIFI';

  // Auto-enable downloaded-only filter on cellular/offline when cached articles exist,
  // while respecting explicit user toggles until the network type actually changes.
  useEffect(() => {
    const currentType = networkState?.type;
    if (!currentType) {
      return;
    }
    if (
      lastNetworkTypeRef.current !== undefined &&
      lastNetworkTypeRef.current !== currentType
    ) {
      manualFilterOverrideRef.current = null;
    }
    lastNetworkTypeRef.current = currentType;

    if (manualFilterOverrideRef.current !== null) {
      return;
    }

    if (currentType !== 'WIFI' && cacheEntries.length > 0) {
      setDownloadedOnly(true);
    } else if (currentType === 'WIFI') {
      setDownloadedOnly(false);
    }
  }, [networkState?.type, cacheEntries.length]);

  const downloadedInTabCount = useMemo(
    () =>
      articles.filter(
        (article) => Boolean(article.isPrefetched) || cachedIdSet.has(article.id)
      ).length,
    [articles, cachedIdSet]
  );

  const displayedArticles = useMemo(
    () =>
      downloadedOnly
        ? articles.filter(
            (article) =>
              Boolean(article.isPrefetched) || cachedIdSet.has(article.id)
          )
        : articles,
    [articles, downloadedOnly, cachedIdSet]
  );

  const handleToggleDownloadedOnly = useCallback(() => {
    setDownloadedOnly((prev) => {
      const next = !prev;
      manualFilterOverrideRef.current = next;
      return next;
    });
  }, []);

  const handleShowAllArticles = useCallback(() => {
    manualFilterOverrideRef.current = false;
    setDownloadedOnly(false);
  }, []);

  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await syncNow();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [syncNow]);

  const handleSelectBatchSize = useCallback(
    async (count: number) => {
      setIsCountPickerOpen(false);
      await setPrefetchBatchSize(count);
    },
    [setPrefetchBatchSize]
  );

  // Keep selectedPackId valid once initial catalog data is ready.
  useEffect(() => {
    if (!isReady || availablePacks.length === 0) {
      return;
    }
    const stillExists = availablePacks.some(
      (pack) => pack.packId === selectedPackId
    );
    if (!stillExists) {
      setSelectedPackId(availablePacks[0].packId);
      setSelectedCategory(ALL_CATEGORIES);
    }
  }, [isReady, availablePacks, selectedPackId]);

  const categories = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const list: string[] = [ALL_CATEGORIES];
    for (const feed of resolvedFeeds) {
      if (feed.packId !== selectedPackId || !feed.enabled || feed.muted) {
        continue;
      }
      if (feed.category && !seen.has(feed.category)) {
        seen.add(feed.category);
        list.push(feed.category);
      }
    }
    return list;
  }, [resolvedFeeds, selectedPackId]);

  useEffect(() => {
    if (!categories.includes(selectedCategory)) {
      setSelectedCategory(ALL_CATEGORIES);
    }
  }, [categories, selectedCategory]);

  const loadRequestIdRef = React.useRef(0);

  const loadArticles = useCallback(async () => {
    if (!isReady || initError) {
      return;
    }
    const requestId = ++loadRequestIdRef.current;
    setIsLoadingArticles(true);
    try {
      const categoryArg =
        selectedCategory === ALL_CATEGORIES ? undefined : selectedCategory;
      const items = await listArticlesByPackAndCategory(
        selectedPackId,
        categoryArg
      );
      if (loadRequestIdRef.current === requestId) {
        setArticles(items);
      }
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoadingArticles(false);
      }
    }
  }, [
    isReady,
    initError,
    selectedPackId,
    selectedCategory,
    listArticlesByPackAndCategory,
  ]);

  useEffect(() => {
    void loadArticles();
  }, [loadArticles, dataVersion]);

  const handleSelectPack = useCallback((packId: string) => {
    setSelectedPackId(packId);
    setSelectedCategory(ALL_CATEGORIES);
  }, []);

  const handleOpenArticle = useCallback(
    (article: Article) => {
      router.push(`/article/${article.id}` as Href);
    },
    [router]
  );

  const handleToggleSave = useCallback(
    (article: Article) => {
      void toggleSaved(article.id);
    },
    [toggleSaved]
  );

  const handleMuteSite = useCallback(
    (article: Article) => {
      const isCustom = article.packId === MY_RSS_PACK_ID;
      void muteSite(article.siteId, isCustom);
    },
    [muteSite]
  );

  const renderEmpty = () => {
    if (initError) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyTitle, { color: colors.danger }]}>
            データの読み込みに失敗しました
          </Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {initError}
          </Text>
        </View>
      );
    }

    if (!isReady || isLoadingArticles) {
      return (
        <View style={styles.emptyContainer}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            記事を読み込み中です…
          </Text>
        </View>
      );
    }

    if (selectedPackId === MY_RSS_PACK_ID && customFeeds.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            マイRSSにまだサイトがありません
          </Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            下の「ソース・設定」タブから好きなRSSやブログを追加できます。
          </Text>
        </View>
      );
    }

    if (downloadedOnly && articles.length > 0 && displayedArticles.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            このタブにダウンロード済み記事がありません
          </Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Wi-Fi接続時に「Wi-Fiダウンロード」を実行するか、すべての記事を表示してください。
          </Text>
          <Pressable
            testID="home-show-all-articles-button"
            accessibilityRole="button"
            onPress={handleShowAllArticles}
            style={[styles.refreshBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.refreshBtnText}>すべて表示に戻す</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          表示できる記事がまだありません
        </Text>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          下に引っ張って更新するか、下のボタンから最新記事を取得できます。
        </Text>
        <Pressable
          testID="home-refresh-button"
          accessibilityRole="button"
          onPress={() => void syncNow()}
          style={[styles.refreshBtn, { backgroundColor: colors.accent }]}
        >
          <Text style={styles.refreshBtnText}>
            {isSyncing ? '更新中…' : '今すぐ更新'}
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PackSwitcher
        packs={availablePacks}
        selectedPackId={selectedPackId}
        onSelectPack={handleSelectPack}
      />
      <CategoryBar
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />

      <View
        style={[
          styles.prefetchBar,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <Pressable
          testID="home-downloaded-filter-button"
          accessibilityRole="button"
          accessibilityState={{ selected: downloadedOnly }}
          onPress={handleToggleDownloadedOnly}
          style={[
            styles.filterChip,
            {
              backgroundColor: downloadedOnly
                ? colors.badgeSuccessBg
                : colors.surfaceSecondary,
              borderColor: downloadedOnly
                ? colors.badgeSuccessText
                : colors.border,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[
              styles.filterChipText,
              {
                color: downloadedOnly
                  ? colors.badgeSuccessText
                  : colors.textSecondary,
              },
            ]}
          >
            {downloadedOnly
              ? `✓ ダウンロード済みのみ (${downloadedInTabCount})`
              : `ダウンロード済みのみ (${downloadedInTabCount})`}
          </Text>
        </Pressable>
        {isSyncing || isPrefetching ? (
          <Pressable
            testID="home-prefetch-cancel-button"
            accessibilityRole="button"
            accessibilityLabel="取得をキャンセル"
            onPress={cancelSyncAndPrefetch}
            style={[
              styles.cancelActiveBtn,
              {
                backgroundColor: colors.dangerSoft,
                borderColor: colors.danger,
              },
            ]}
          >
            <ActivityIndicator size="small" color={colors.danger} />
            <Text
              numberOfLines={1}
              style={[styles.cancelActiveBtnText, { color: colors.danger }]}
            >
              {isSyncing ? '取得中… ✕' : 'DL中… ✕'}
            </Text>
          </Pressable>
        ) : (
          <View
            style={[
              styles.splitBtnGroup,
              { backgroundColor: colors.accent },
            ]}
          >
            <Pressable
              testID="home-prefetch-button"
              accessibilityRole="button"
              onPress={() =>
                void syncAndPrefetchNow({
                  preferredPackId: selectedPackId,
                  preferredCategory:
                    selectedCategory === ALL_CATEGORIES
                      ? undefined
                      : selectedCategory,
                })
              }
              style={styles.splitMainBtn}
            >
              <Text numberOfLines={1} style={styles.prefetchBtnText}>
                {`Wi-Fi DL (${prefetchBatchSize}件)`}
              </Text>
            </Pressable>
            <View style={styles.splitDivider} />
            <Pressable
              testID="home-prefetch-count-picker-button"
              accessibilityRole="button"
              accessibilityLabel="Wi-Fiダウンロード件数を変更"
              hitSlop={{ top: 8, bottom: 8, right: 8, left: 2 }}
              onPress={() => setIsCountPickerOpen(true)}
              style={styles.splitChevronBtn}
            >
              <Text style={styles.splitChevronText}>▾</Text>
            </Pressable>
          </View>
        )}
      </View>

      {isNonWifi && downloadedOnly ? (
        <View
          testID="home-cellular-filter-banner"
          style={[
            styles.noticeBanner,
            {
              backgroundColor: colors.badgeSuccessBg,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.noticeBannerText, { color: colors.badgeSuccessText }]}
          >
            携帯回線中のためダウンロード済み記事を表示中（全{cacheEntries.length}件）
          </Text>
        </View>
      ) : lastPrefetchResult?.skippedNotWifi ? (
        <View
          style={[
            styles.noticeBanner,
            {
              backgroundColor: colors.surfaceSecondary,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.noticeBannerText, { color: colors.textSecondary }]}
          >
            Wi-Fi未接続のためダウンロード待機中
          </Text>
        </View>
      ) : null}

      <FlatList
        data={displayedArticles}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          displayedArticles.length === 0
            ? styles.emptyListContent
            : styles.listContent
        }
        refreshControl={
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullRefresh()}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item }) => (
          <ArticleRow
            article={item}
            onPress={handleOpenArticle}
            onToggleSave={handleToggleSave}
            onMuteSite={handleMuteSite}
          />
        )}
        ListEmptyComponent={renderEmpty}
      />

      <Modal
        visible={isCountPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsCountPickerOpen(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            testID="home-prefetch-count-backdrop"
            style={styles.sheetBackdrop}
            onPress={() => setIsCountPickerOpen(false)}
          />
          <View
            testID="home-prefetch-count-sheet"
            style={[
              styles.sheetContainer,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <View
              style={[styles.sheetHandle, { backgroundColor: colors.border }]}
            />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              Wi-Fiダウンロード件数
            </Text>
            <Text
              style={[styles.sheetSubtitle, { color: colors.textSecondary }]}
            >
              外出時間や余裕に合わせて件数を切り替えられます
            </Text>

            <View
              style={[
                styles.sheetOptions,
                { borderColor: colors.border, backgroundColor: colors.background },
              ]}
            >
              {PREFETCH_BATCH_SIZE_OPTIONS.map((count, index) => {
                const selected = count === prefetchBatchSize;
                return (
                  <Pressable
                    key={count}
                    testID={`home-prefetch-count-option-${count}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => void handleSelectBatchSize(count)}
                    style={[
                      styles.sheetOptionRow,
                      index > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                      },
                      selected && { backgroundColor: colors.accentSoft },
                    ]}
                  >
                    <View style={styles.sheetOptionTextCol}>
                      <Text
                        style={[
                          styles.sheetOptionTitle,
                          { color: selected ? colors.accentText : colors.text },
                        ]}
                      >
                        {count}件
                      </Text>
                      <Text
                        style={[
                          styles.sheetOptionDesc,
                          {
                            color: selected
                              ? colors.accentText
                              : colors.textSecondary,
                          },
                        ]}
                      >
                        {PREFETCH_BATCH_DESCRIPTIONS[count] ?? ''}
                      </Text>
                    </View>
                    {selected ? (
                      <Text
                        style={[
                          styles.sheetCheck,
                          { color: colors.accentText },
                        ]}
                      >
                        ✓
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              testID="home-prefetch-count-cancel"
              accessibilityRole="button"
              onPress={() => setIsCountPickerOpen(false)}
              style={[
                styles.sheetCancelBtn,
                { backgroundColor: colors.surfaceSecondary },
              ]}
            >
              <Text style={[styles.sheetCancelText, { color: colors.text }]}>
                キャンセル
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  prefetchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterChip: {
    flexShrink: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  splitBtnGroup: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    borderRadius: 9,
    overflow: 'hidden',
  },
  splitMainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingLeft: 11,
    paddingRight: 9,
    paddingVertical: 8,
  },
  splitDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  splitChevronBtn: {
    minWidth: 42,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splitChevronText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  cancelActiveBtn: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cancelActiveBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  prefetchBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheetContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 32,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    alignSelf: 'center',
    marginBottom: 14,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  sheetSubtitle: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 14,
  },
  sheetOptions: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  sheetOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  sheetOptionTextCol: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  sheetOptionTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  sheetOptionDesc: {
    fontSize: 12,
    fontWeight: '500',
  },
  sheetCheck: {
    fontSize: 16,
    fontWeight: '700',
  },
  sheetCancelBtn: {
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCancelText: {
    fontSize: 15,
    fontWeight: '600',
  },
  noticeBanner: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  noticeBannerText: {
    fontSize: 11,
    fontWeight: '600',
  },
  listContent: {
    paddingVertical: 8,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 40,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  refreshBtn: {
    marginTop: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  refreshBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
