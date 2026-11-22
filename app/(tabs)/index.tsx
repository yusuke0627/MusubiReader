import { type Href, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ArticleRow } from '../../src/components/ArticleRow';
import { ALL_CATEGORIES, CategoryBar } from '../../src/components/CategoryBar';
import { PackSwitcher, type PackTabItem } from '../../src/components/PackSwitcher';
import { MY_RSS_PACK_ID } from '../../src/domain/catalog-merge';
import type { Article } from '../../src/domain/types';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

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
    isSyncing,
    dataVersion,
    syncNow,
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

      {isSyncing ? (
        <View
          style={[
            styles.syncBanner,
            { backgroundColor: colors.accentSoft, borderBottomColor: colors.border },
          ]}
        >
          <Text style={[styles.syncBannerText, { color: colors.accentText }]}>
            新着記事をバックグラウンドで取得中…
          </Text>
        </View>
      ) : null}

      <FlatList
        data={articles}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          articles.length === 0 ? styles.emptyListContent : styles.listContent
        }
        refreshControl={
          <RefreshControl
            refreshing={isSyncing}
            onRefresh={() => void syncNow()}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  syncBanner: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  syncBannerText: {
    fontSize: 12,
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
