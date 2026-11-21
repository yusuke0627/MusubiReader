import { type Href, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ArticleRow } from '../../src/components/ArticleRow';
import { MY_RSS_PACK_ID } from '../../src/domain/catalog-merge';
import type { Article } from '../../src/domain/types';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

type PickupSegment = 'matched' | 'saved';

interface PickupDisplayItem {
  article: Article;
  matchedKeywords?: string[];
}

export default function PickupScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const {
    isReady,
    initError,
    interestKeywords,
    isSyncing,
    dataVersion,
    syncNow,
    listPickupArticles,
    listSavedArticles,
    addInterestKeyword,
    deleteInterestKeyword,
    toggleSaved,
    muteSite,
  } = useAppData();

  const [segment, setSegment] = useState<PickupSegment>('matched');
  const [keywordDraft, setKeywordDraft] = useState('');
  const [items, setItems] = useState<PickupDisplayItem[]>([]);

  const loadItems = useCallback(async () => {
    if (!isReady || initError) {
      return;
    }
    if (segment === 'matched') {
      const matched = await listPickupArticles();
      setItems(matched);
    } else {
      const saved = await listSavedArticles();
      setItems(saved.map((article) => ({ article })));
    }
  }, [isReady, initError, segment, listPickupArticles, listSavedArticles]);

  useEffect(() => {
    void loadItems();
  }, [loadItems, dataVersion]);

  const handleAddKeyword = useCallback(async () => {
    const added = await addInterestKeyword(keywordDraft);
    if (added) {
      setKeywordDraft('');
    }
  }, [addInterestKeyword, keywordDraft]);

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

  const renderKeywordsHeader = () => {
    if (segment !== 'matched') {
      return null;
    }

    return (
      <View
        style={[
          styles.keywordPanel,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
          登録中の興味ワード（全パック横断で監視）
        </Text>
        <View style={styles.inputRow}>
          <TextInput
            testID="pickup-keyword-input"
            value={keywordDraft}
            onChangeText={setKeywordDraft}
            placeholder="興味ワードを追加（例: TypeScript, AI）"
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            onSubmitEditing={() => void handleAddKeyword()}
            style={[
              styles.input,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
          />
          <Pressable
            testID="pickup-keyword-add"
            accessibilityRole="button"
            onPress={() => void handleAddKeyword()}
            style={[styles.addBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.addBtnText}>追加</Text>
          </Pressable>
        </View>

        {interestKeywords.length > 0 ? (
          <View style={styles.chipsWrap}>
            {interestKeywords.map((kw) => (
              <View
                key={kw.id}
                style={[
                  styles.chip,
                  {
                    backgroundColor: colors.accentSoft,
                    borderColor: colors.accent,
                  },
                ]}
              >
                <Text style={[styles.chipWord, { color: colors.accentText }]}>
                  {kw.word}
                </Text>
                <Pressable
                  testID={`pickup-keyword-delete-${kw.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${kw.word}を削除`}
                  onPress={() => void deleteInterestKeyword(kw.id)}
                  style={[
                    styles.chipDeleteBtn,
                    { backgroundColor: colors.surface },
                  ]}
                >
                  <Text
                    style={[styles.chipDeleteText, { color: colors.danger }]}
                  >
                    削除
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <Text style={[styles.helperText, { color: colors.textMuted }]}>
            興味ワードを追加すると、一致する新着記事を自動でピックアップします。
          </Text>
        )}
      </View>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        {segment === 'matched'
          ? '一致する記事がまだありません'
          : '保存済みの記事はまだありません'}
      </Text>
      <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
        {segment === 'matched'
          ? '興味ワードを登録すると、5chまとめ・Tech・マイRSSを横断して一致した記事が表示されます。'
          : '記事の「メニュー」から「後で読む」を選ぶとここに保存されます。'}
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.segmentBar,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <View
          style={[
            styles.segmentTrack,
            { backgroundColor: colors.surfaceSecondary },
          ]}
        >
          <Pressable
            testID="pickup-segment-matched"
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === 'matched' }}
            onPress={() => setSegment('matched')}
            style={[
              styles.segmentTab,
              segment === 'matched'
                ? { backgroundColor: colors.surface }
                : undefined,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                {
                  color:
                    segment === 'matched' ? colors.text : colors.textSecondary,
                },
              ]}
            >
              キーワード一致
            </Text>
          </Pressable>

          <Pressable
            testID="pickup-segment-saved"
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === 'saved' }}
            onPress={() => setSegment('saved')}
            style={[
              styles.segmentTab,
              segment === 'saved'
                ? { backgroundColor: colors.surface }
                : undefined,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                {
                  color:
                    segment === 'saved' ? colors.text : colors.textSecondary,
                },
              ]}
            >
              保存済み
            </Text>
          </Pressable>
        </View>
      </View>

      {renderKeywordsHeader()}

      <FlatList
        data={items}
        keyExtractor={(item) => item.article.id}
        contentContainerStyle={
          items.length === 0 ? styles.emptyListContent : styles.listContent
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
            article={item.article}
            matchedKeywords={item.matchedKeywords}
            onPress={handleOpenArticle}
            onToggleSave={handleToggleSave}
            onMuteSite={segment === 'matched' ? handleMuteSite : undefined}
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
  segmentBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  segmentTrack: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
  },
  segmentTab: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '600',
  },
  keywordPanel: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  addBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  addBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 5,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
  },
  chipWord: {
    fontSize: 13,
    fontWeight: '600',
  },
  chipDeleteBtn: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
  },
  chipDeleteText: {
    fontSize: 11,
    fontWeight: '600',
  },
  helperText: {
    fontSize: 13,
    lineHeight: 18,
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
    gap: 8,
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
