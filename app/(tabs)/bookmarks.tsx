import { type Href, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ArticleRow } from '../../src/components/ArticleRow';
import { normalizeText } from '../../src/domain/curation';
import type { Article } from '../../src/domain/types';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

export default function BookmarksScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const {
    isReady,
    initError,
    dataVersion,
    listSavedArticles,
    toggleSaved,
  } = useAppData();

  const [bookmarks, setBookmarks] = useState<Article[]>([]);
  const [query, setQuery] = useState('');
  const loadRequestIdRef = useRef(0);

  const loadBookmarks = useCallback(async () => {
    if (!isReady || initError) {
      return;
    }
    const requestId = ++loadRequestIdRef.current;
    const saved = await listSavedArticles();
    if (loadRequestIdRef.current === requestId) {
      setBookmarks(saved);
    }
  }, [isReady, initError, listSavedArticles]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks, dataVersion]);

  const filteredBookmarks = useMemo(() => {
    const normalized = normalizeText(query);
    if (!normalized) {
      return bookmarks;
    }
    return bookmarks.filter((article) => {
      const target = normalizeText(
        `${article.title} ${article.siteName} ${article.category}`
      );
      return target.includes(normalized);
    });
  }, [bookmarks, query]);

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

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        {bookmarks.length === 0
          ? 'ブックマークした記事はまだありません'
          : '条件に一致するブックマークがありません'}
      </Text>
      <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
        {bookmarks.length === 0
          ? '記事一覧や記事画面の「ブックマーク」ボタンからワンタップで保存できます。ブックマークした記事は自動パージから保護されます。'
          : '検索ワードを変更するかクリアしてみてください。'}
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.headerPanel,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <View style={styles.headerMetaRow}>
          <Text
            testID="bookmarks-count-label"
            style={[styles.countText, { color: colors.text }]}
          >
            {`ブックマーク（${bookmarks.length}件）`}
          </Text>
          <Text style={[styles.protectBadge, { color: colors.badgeSavedText }]}>
            自動削除から保護中
          </Text>
        </View>

        <View style={styles.searchRow}>
          <TextInput
            testID="bookmarks-search-input"
            value={query}
            onChangeText={setQuery}
            placeholder="タイトル・サイト名で絞り込み"
            placeholderTextColor={colors.textMuted}
            returnKeyType="search"
            style={[
              styles.searchInput,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
          />
          {query.length > 0 ? (
            <Pressable
              testID="bookmarks-search-clear"
              accessibilityRole="button"
              onPress={() => setQuery('')}
              style={[
                styles.clearBtn,
                { backgroundColor: colors.surfaceSecondary },
              ]}
            >
              <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>
                クリア
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <FlatList
        data={filteredBookmarks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          filteredBookmarks.length === 0
            ? styles.emptyListContent
            : styles.listContent
        }
        renderItem={({ item }) => (
          <ArticleRow
            article={item}
            onPress={handleOpenArticle}
            onToggleSave={handleToggleSave}
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
  headerPanel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  headerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countText: {
    fontSize: 14,
    fontWeight: '700',
  },
  protectBadge: {
    fontSize: 11,
    fontWeight: '700',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  clearBtn: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  clearBtnText: {
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
});
