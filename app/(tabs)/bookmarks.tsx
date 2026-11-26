import { type Href, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
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

const FOLDER_FILTER_ALL = '__ALL__';
const FOLDER_FILTER_UNFILED = '__UNFILED__';
const UNDO_TOAST_DURATION_MS = 5000;

export default function BookmarksScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const {
    isReady,
    initError,
    dataVersion,
    bookmarkFolders,
    listSavedArticles,
    toggleSaved,
    createBookmarkFolder,
    deleteBookmarkFolder,
    setArticleBookmarkFolder,
  } = useAppData();

  const [bookmarks, setBookmarks] = useState<Article[]>([]);
  const [query, setQuery] = useState('');
  const [selectedFolderFilter, setSelectedFolderFilter] =
    useState<string>(FOLDER_FILTER_ALL);
  const [isAddFolderOpen, setIsAddFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [assigningArticle, setAssigningArticle] = useState<Article | null>(null);
  const [pendingUndoArticle, setPendingUndoArticle] = useState<Article | null>(
    null
  );

  const loadRequestIdRef = useRef(0);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearUndoTimer();
    };
  }, [clearUndoTimer]);

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

  // Reset folder filter if the currently selected custom folder was deleted.
  useEffect(() => {
    if (
      selectedFolderFilter !== FOLDER_FILTER_ALL &&
      selectedFolderFilter !== FOLDER_FILTER_UNFILED &&
      !bookmarkFolders.some((f) => f.id === selectedFolderFilter)
    ) {
      setSelectedFolderFilter(FOLDER_FILTER_ALL);
    }
  }, [bookmarkFolders, selectedFolderFilter]);

  const folderNameById = useMemo(
    () => new Map(bookmarkFolders.map((folder) => [folder.id, folder.name])),
    [bookmarkFolders]
  );

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const article of bookmarks) {
      const fid = article.bookmarkFolderId;
      if (fid && folderNameById.has(fid)) {
        counts.set(fid, (counts.get(fid) ?? 0) + 1);
      } else {
        unfiled += 1;
      }
    }
    return { counts, unfiled };
  }, [bookmarks, folderNameById]);

  const filteredBookmarks = useMemo(() => {
    const normalized = normalizeText(query);
    return bookmarks.filter((article) => {
      const fid = article.bookmarkFolderId;
      const validFolderId = fid && folderNameById.has(fid) ? fid : null;

      if (selectedFolderFilter === FOLDER_FILTER_UNFILED) {
        if (validFolderId !== null) {
          return false;
        }
      } else if (selectedFolderFilter !== FOLDER_FILTER_ALL) {
        if (validFolderId !== selectedFolderFilter) {
          return false;
        }
      }

      if (!normalized) {
        return true;
      }
      const folderLabel = validFolderId
        ? folderNameById.get(validFolderId) ?? ''
        : '';
      const target = normalizeText(
        `${article.title} ${article.siteName} ${article.category} ${folderLabel}`
      );
      return target.includes(normalized);
    });
  }, [bookmarks, query, selectedFolderFilter, folderNameById]);

  const handleOpenArticle = useCallback(
    (article: Article) => {
      router.push(`/article/${article.id}` as Href);
    },
    [router]
  );

  const handleToggleSave = useCallback(
    (article: Article) => {
      clearUndoTimer();
      setPendingUndoArticle(article);
      undoTimerRef.current = setTimeout(() => {
        setPendingUndoArticle(null);
        undoTimerRef.current = null;
      }, UNDO_TOAST_DURATION_MS);
      void toggleSaved(article.id);
    },
    [clearUndoTimer, toggleSaved]
  );

  const handleUndoRemove = useCallback(() => {
    if (!pendingUndoArticle) {
      return;
    }
    const target = pendingUndoArticle;
    clearUndoTimer();
    setPendingUndoArticle(null);
    void toggleSaved(target.id);
  }, [pendingUndoArticle, clearUndoTimer, toggleSaved]);

  const handleCreateFolder = useCallback(async () => {
    const created = await createBookmarkFolder(newFolderName);
    if (!created) {
      return;
    }
    setNewFolderName('');
    setIsAddFolderOpen(false);
    if (assigningArticle) {
      const targetId = assigningArticle.id;
      setAssigningArticle(null);
      await setArticleBookmarkFolder(targetId, created.id);
    }
  }, [
    createBookmarkFolder,
    newFolderName,
    assigningArticle,
    setArticleBookmarkFolder,
  ]);

  const handleAssignFolder = useCallback(
    async (folderId: string | null) => {
      if (!assigningArticle) {
        return;
      }
      const targetId = assigningArticle.id;
      setAssigningArticle(null);
      await setArticleBookmarkFolder(targetId, folderId);
    },
    [assigningArticle, setArticleBookmarkFolder]
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      await deleteBookmarkFolder(folderId);
    },
    [deleteBookmarkFolder]
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
          : 'フォルダや検索ワードを変更してみてください。'}
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
            placeholder="タイトル・サイト名・フォルダで絞り込み"
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

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.folderBarContent}
        >
          <Pressable
            testID="bookmark-folder-tab-all"
            accessibilityRole="button"
            accessibilityState={{
              selected: selectedFolderFilter === FOLDER_FILTER_ALL,
            }}
            onPress={() => setSelectedFolderFilter(FOLDER_FILTER_ALL)}
            style={[
              styles.folderTab,
              {
                backgroundColor:
                  selectedFolderFilter === FOLDER_FILTER_ALL
                    ? colors.accent
                    : colors.surfaceSecondary,
              },
            ]}
          >
            <Text
              style={[
                styles.folderTabText,
                {
                  color:
                    selectedFolderFilter === FOLDER_FILTER_ALL
                      ? '#FFFFFF'
                      : colors.text,
                },
              ]}
            >
              {`すべて (${bookmarks.length})`}
            </Text>
          </Pressable>

          <Pressable
            testID="bookmark-folder-tab-unfiled"
            accessibilityRole="button"
            accessibilityState={{
              selected: selectedFolderFilter === FOLDER_FILTER_UNFILED,
            }}
            onPress={() => setSelectedFolderFilter(FOLDER_FILTER_UNFILED)}
            style={[
              styles.folderTab,
              {
                backgroundColor:
                  selectedFolderFilter === FOLDER_FILTER_UNFILED
                    ? colors.accent
                    : colors.surfaceSecondary,
              },
            ]}
          >
            <Text
              style={[
                styles.folderTabText,
                {
                  color:
                    selectedFolderFilter === FOLDER_FILTER_UNFILED
                      ? '#FFFFFF'
                      : colors.text,
                },
              ]}
            >
              {`未分類 (${folderCounts.unfiled})`}
            </Text>
          </Pressable>

          {bookmarkFolders.map((folder) => {
            const active = selectedFolderFilter === folder.id;
            const count = folderCounts.counts.get(folder.id) ?? 0;
            return (
              <View key={folder.id} style={styles.customFolderTabWrap}>
                <Pressable
                  testID={`bookmark-folder-tab-${folder.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setSelectedFolderFilter(folder.id)}
                  style={[
                    styles.folderTab,
                    {
                      backgroundColor: active
                        ? colors.accent
                        : colors.surfaceSecondary,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.folderTabText,
                      { color: active ? '#FFFFFF' : colors.text },
                    ]}
                  >
                    {`${folder.name} (${count})`}
                  </Text>
                </Pressable>
                {active ? (
                  <Pressable
                    testID={`bookmark-folder-delete-${folder.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${folder.name}フォルダを削除`}
                    onPress={() => void handleDeleteFolder(folder.id)}
                    style={[
                      styles.folderDeleteBtn,
                      { backgroundColor: colors.dangerSoft },
                    ]}
                  >
                    <Text
                      style={[
                        styles.folderDeleteText,
                        { color: colors.danger },
                      ]}
                    >
                      ✕
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}

          <Pressable
            testID="bookmarks-add-folder-button"
            accessibilityRole="button"
            onPress={() => {
              setAssigningArticle(null);
              setIsAddFolderOpen(true);
            }}
            style={[
              styles.folderTab,
              styles.addFolderTab,
              { borderColor: colors.accent },
            ]}
          >
            <Text style={[styles.folderTabText, { color: colors.accentText }]}>
              ＋ フォルダ
            </Text>
          </Pressable>
        </ScrollView>
      </View>

      <FlatList
        data={filteredBookmarks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          filteredBookmarks.length === 0
            ? styles.emptyListContent
            : styles.listContent
        }
        renderItem={({ item }) => {
          const folderName =
            item.bookmarkFolderId && folderNameById.has(item.bookmarkFolderId)
              ? folderNameById.get(item.bookmarkFolderId)!
              : '未分類';
          return (
            <View>
              <ArticleRow
                article={item}
                onPress={handleOpenArticle}
                onToggleSave={handleToggleSave}
              />
              <View style={styles.folderChipRow}>
                <Pressable
                  testID={`bookmark-folder-chip-${item.id}`}
                  accessibilityRole="button"
                  onPress={() => setAssigningArticle(item)}
                  style={[
                    styles.articleFolderChip,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.articleFolderChipText,
                      { color: colors.textSecondary },
                    ]}
                  >
                    {`📁 ${folderName} ▾`}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={renderEmpty}
      />

      {pendingUndoArticle ? (
        <View
          testID="bookmarks-undo-bar"
          style={[
            styles.undoBar,
            { backgroundColor: colors.text, borderColor: colors.border },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.undoText, { color: colors.background }]}
          >
            ブックマークを解除しました
          </Text>
          <Pressable
            testID="bookmarks-undo-button"
            accessibilityRole="button"
            onPress={handleUndoRemove}
            style={[styles.undoBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.undoBtnText}>元に戻す</Text>
          </Pressable>
        </View>
      ) : null}

      <Modal
        visible={isAddFolderOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsAddFolderOpen(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setIsAddFolderOpen(false)}
          />
          <View
            testID="bookmark-add-folder-sheet"
            style={[
              styles.sheetContainer,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <View
              style={[styles.sheetHandle, { backgroundColor: colors.border }]}
            />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              新しいフォルダを作成
            </Text>
            <TextInput
              testID="bookmark-new-folder-input"
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="例: 後でじっくり、仕事・技術、レシピ"
              placeholderTextColor={colors.textMuted}
              returnKeyType="done"
              onSubmitEditing={() => void handleCreateFolder()}
              style={[
                styles.sheetInput,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                  color: colors.text,
                },
              ]}
            />
            <View style={styles.sheetActionsRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setIsAddFolderOpen(false);
                  setNewFolderName('');
                }}
                style={[
                  styles.sheetActionBtn,
                  { backgroundColor: colors.surfaceSecondary },
                ]}
              >
                <Text
                  style={[styles.sheetActionText, { color: colors.text }]}
                >
                  キャンセル
                </Text>
              </Pressable>
              <Pressable
                testID="bookmark-new-folder-submit"
                accessibilityRole="button"
                onPress={() => void handleCreateFolder()}
                style={[
                  styles.sheetActionBtn,
                  { backgroundColor: colors.accent },
                ]}
              >
                <Text style={[styles.sheetActionText, { color: '#FFFFFF' }]}>
                  作成
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={assigningArticle !== null && !isAddFolderOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAssigningArticle(null)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setAssigningArticle(null)}
          />
          <View
            testID="bookmark-folder-sheet"
            style={[
              styles.sheetContainer,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <View
              style={[styles.sheetHandle, { backgroundColor: colors.border }]}
            />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              フォルダを選択
            </Text>
            <View
              style={[
                styles.sheetOptions,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                },
              ]}
            >
              <Pressable
                testID="bookmark-assign-unfiled"
                accessibilityRole="button"
                onPress={() => void handleAssignFolder(null)}
                style={[
                  styles.sheetOptionRow,
                  !assigningArticle?.bookmarkFolderId && {
                    backgroundColor: colors.accentSoft,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.sheetOptionTitle,
                    {
                      color: !assigningArticle?.bookmarkFolderId
                        ? colors.accentText
                        : colors.text,
                    },
                  ]}
                >
                  📁 未分類
                </Text>
                {!assigningArticle?.bookmarkFolderId ? (
                  <Text
                    style={[styles.sheetCheck, { color: colors.accentText }]}
                  >
                    ✓
                  </Text>
                ) : null}
              </Pressable>

              {bookmarkFolders.map((folder) => {
                const selected =
                  assigningArticle?.bookmarkFolderId === folder.id;
                return (
                  <Pressable
                    key={folder.id}
                    testID={`bookmark-assign-folder-${folder.id}`}
                    accessibilityRole="button"
                    onPress={() => void handleAssignFolder(folder.id)}
                    style={[
                      styles.sheetOptionRow,
                      {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                      },
                      selected && { backgroundColor: colors.accentSoft },
                    ]}
                  >
                    <Text
                      style={[
                        styles.sheetOptionTitle,
                        { color: selected ? colors.accentText : colors.text },
                      ]}
                    >
                      {`📁 ${folder.name}`}
                    </Text>
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
              testID="bookmark-assign-create-folder"
              accessibilityRole="button"
              onPress={() => setIsAddFolderOpen(true)}
              style={[
                styles.sheetCreateInlineBtn,
                { borderColor: colors.accent },
              ]}
            >
              <Text
                style={[styles.sheetActionText, { color: colors.accentText }]}
              >
                ＋ 新しいフォルダを作って移動
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => setAssigningArticle(null)}
              style={[
                styles.sheetCancelBtn,
                { backgroundColor: colors.surfaceSecondary },
              ]}
            >
              <Text style={[styles.sheetActionText, { color: colors.text }]}>
                閉じる
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
    fontSize: 15,
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
    borderWidth: 1,
    borderRadius: 10,
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
  folderBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 2,
    paddingBottom: 2,
  },
  customFolderTabWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  folderTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  addFolderTab: {
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  folderTabText: {
    fontSize: 12,
    fontWeight: '700',
  },
  folderDeleteBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderDeleteText: {
    fontSize: 11,
    fontWeight: '800',
  },
  listContent: {
    paddingVertical: 8,
    paddingBottom: 76,
  },
  folderChipRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    marginTop: -4,
    marginBottom: 8,
  },
  articleFolderChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  articleFolderChipText: {
    fontSize: 11,
    fontWeight: '600',
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
  undoBar: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    shadowColor: '#000000',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  undoText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  undoBtn: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  undoBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
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
    marginBottom: 14,
  },
  sheetInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 14,
  },
  sheetActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sheetActionBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetActionText: {
    fontSize: 14,
    fontWeight: '700',
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
  sheetOptionTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  sheetCheck: {
    fontSize: 16,
    fontWeight: '700',
  },
  sheetCreateInlineBtn: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCancelBtn: {
    marginTop: 10,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
