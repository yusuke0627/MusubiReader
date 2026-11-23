import { type Href, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { PREFETCH_BATCH_SIZE_OPTIONS } from '../../src/data/repositories/settings-repository';
import { useAppData } from '../../src/state/app-context';
import { useThemeColors } from '../../src/theme/tokens';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SourcesScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const {
    catalog,
    packSettings,
    feedOverrides,
    customFeeds,
    ngWords,
    cacheEntries,
    networkState,
    isPrefetching,
    lastPrefetchResult,
    prefetchBatchSize,
    refreshNetworkState,
    setPackEnabled,
    addCustomFeed,
    deleteCustomFeed,
    muteSite,
    unmuteSite,
    addNgWord,
    deleteNgWord,
    prefetchNow,
    setPrefetchBatchSize,
    clearPrefetchCache,
  } = useAppData();

  useEffect(() => {
    void refreshNetworkState();
  }, [refreshNetworkState]);

  const [rssUrlDraft, setRssUrlDraft] = useState('');
  const [rssNameDraft, setRssNameDraft] = useState('');
  const [rssFeedback, setRssFeedback] = useState<string | null>(null);
  const [ngWordDraft, setNgWordDraft] = useState('');

  const packSettingMap = useMemo(
    () => new Map(packSettings.map((s) => [s.packId, s.enabled])),
    [packSettings]
  );

  const siteNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const pack of catalog?.packs ?? []) {
      for (const feed of pack.feeds) {
        map.set(feed.siteId, feed.name);
      }
    }
    for (const custom of customFeeds) {
      map.set(custom.siteId, custom.name);
    }
    return map;
  }, [catalog, customFeeds]);

  const mutedEntries = useMemo(() => {
    const entries: Array<{ siteId: string; name: string; isCustom: boolean }> =
      [];
    for (const override of feedOverrides) {
      if (override.muted) {
        entries.push({
          siteId: override.siteId,
          name: siteNameMap.get(override.siteId) ?? override.siteId,
          isCustom: false,
        });
      }
    }
    for (const custom of customFeeds) {
      if (custom.muted) {
        entries.push({
          siteId: custom.siteId,
          name: custom.name,
          isCustom: true,
        });
      }
    }
    return entries;
  }, [feedOverrides, customFeeds, siteNameMap]);

  const totalCacheBytes = useMemo(
    () => cacheEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    [cacheEntries]
  );

  const wifiStatusLabel = useMemo(() => {
    if (!networkState) {
      return '確認中';
    }
    if (networkState.type === 'WIFI' && networkState.isConnected !== false) {
      return 'Wi-Fi接続中（先読み有効）';
    }
    if (networkState.isConnected === false) {
      return 'オフライン';
    }
    return 'モバイル通信中（Wi-Fi時のみ先読み）';
  }, [networkState]);

  const handleAddCustomFeed = useCallback(async () => {
    const res = await addCustomFeed({
      name: rssNameDraft,
      rssUrl: rssUrlDraft,
    });
    if (res.ok) {
      setRssUrlDraft('');
      setRssNameDraft('');
      setRssFeedback('マイRSSに追加しました');
    } else {
      setRssFeedback(res.error ?? '追加できませんでした');
    }
  }, [addCustomFeed, rssNameDraft, rssUrlDraft]);

  const handleAddNgWord = useCallback(async () => {
    const added = await addNgWord(ngWordDraft);
    if (added) {
      setNgWordDraft('');
    }
  }, [addNgWord, ngWordDraft]);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      {/* プリセットパック */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        プリセットパック
      </Text>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        {(catalog?.packs ?? []).map((pack, index) => {
          const enabled = packSettingMap.get(pack.packId) ?? pack.defaultEnabled;
          const activeFeedCount = pack.feeds.filter((f) => !f.deprecated).length;
          return (
            <View
              key={pack.packId}
              style={[
                styles.row,
                index > 0
                  ? {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                    }
                  : undefined,
              ]}
            >
              <View style={styles.rowTextCol}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>
                  {pack.name}（{activeFeedCount}サイト）
                </Text>
                <Text
                  style={[styles.rowSubtitle, { color: colors.textSecondary }]}
                >
                  {pack.description}
                </Text>
              </View>
              <Switch
                testID={`pack-toggle-${pack.packId}`}
                accessibilityLabel={`${pack.name}を有効にする`}
                value={enabled}
                onValueChange={(nextValue) =>
                  void setPackEnabled(pack.packId, nextValue)
                }
              />
            </View>
          );
        })}
      </View>

      {/* マイRSS（汎用RSS追加） */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        マイRSS（汎用RSS・Atomの追加）
      </Text>
      <View
        style={[
          styles.card,
          styles.paddedCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <TextInput
          testID="custom-rss-url-input"
          value={rssUrlDraft}
          onChangeText={(text) => {
            setRssUrlDraft(text);
            if (rssFeedback) setRssFeedback(null);
          }}
          placeholder="RSS / Atom URL (例: https://example.com/feed)"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          keyboardType="url"
          style={[
            styles.input,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
        />
        <TextInput
          testID="custom-rss-name-input"
          value={rssNameDraft}
          onChangeText={setRssNameDraft}
          placeholder="サイト名（省略時はドメイン名）"
          placeholderTextColor={colors.textMuted}
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
          testID="custom-rss-add-button"
          accessibilityRole="button"
          onPress={() => void handleAddCustomFeed()}
          style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
        >
          <Text style={styles.primaryBtnText}>RSSを追加</Text>
        </Pressable>

        {rssFeedback ? (
          <Text
            style={[
              styles.feedbackText,
              {
                color: rssFeedback.includes('追加しました')
                  ? colors.badgeSuccessText
                  : colors.danger,
              },
            ]}
          >
            {rssFeedback}
          </Text>
        ) : null}

        {customFeeds.length > 0 ? (
          <View style={styles.subList}>
            {customFeeds.map((feed) => (
              <View
                key={feed.siteId}
                style={[styles.subRow, { borderTopColor: colors.border }]}
              >
                <View style={styles.rowTextCol}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>
                    {feed.name}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[styles.rowSubtitle, { color: colors.textMuted }]}
                  >
                    {feed.rssUrl}
                  </Text>
                </View>
                <View style={styles.inlineBtns}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      feed.muted
                        ? void unmuteSite(feed.siteId, true)
                        : void muteSite(feed.siteId, true)
                    }
                    style={[
                      styles.smallBtn,
                      { backgroundColor: colors.surfaceSecondary },
                    ]}
                  >
                    <Text
                      style={[styles.smallBtnText, { color: colors.text }]}
                    >
                      {feed.muted ? '表示に戻す' : '非表示'}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void deleteCustomFeed(feed.siteId)}
                    style={[
                      styles.smallBtn,
                      { backgroundColor: colors.dangerSoft },
                    ]}
                  >
                    <Text
                      style={[styles.smallBtnText, { color: colors.danger }]}
                    >
                      削除
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* NGワード管理 */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        NGワード管理
      </Text>
      <View
        style={[
          styles.card,
          styles.paddedCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <View style={styles.inlineInputRow}>
          <TextInput
            testID="ng-word-input"
            value={ngWordDraft}
            onChangeText={setNgWordDraft}
            placeholder="非表示にしたいワードを追加"
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            onSubmitEditing={() => void handleAddNgWord()}
            style={[
              styles.input,
              styles.flexInput,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
          />
          <Pressable
            testID="ng-word-add-button"
            accessibilityRole="button"
            onPress={() => void handleAddNgWord()}
            style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.primaryBtnText}>追加</Text>
          </Pressable>
        </View>

        {ngWords.length === 0 ? (
          <Text style={[styles.emptyHint, { color: colors.textMuted }]}>
            登録中のNGワードはありません
          </Text>
        ) : (
          <View style={styles.subList}>
            {ngWords.map((ng) => (
              <View
                key={ng.id}
                style={[styles.subRow, { borderTopColor: colors.border }]}
              >
                <Text style={[styles.rowTitle, { color: colors.text }]}>
                  {ng.word}
                </Text>
                <Pressable
                  testID={`delete-ng-word-${ng.id}`}
                  accessibilityRole="button"
                  onPress={() => void deleteNgWord(ng.id)}
                  style={[
                    styles.smallBtn,
                    { backgroundColor: colors.dangerSoft },
                  ]}
                >
                  <Text style={[styles.smallBtnText, { color: colors.danger }]}>
                    削除
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 非表示にしたサイト */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        非表示にしたサイト
      </Text>
      <View
        style={[
          styles.card,
          styles.paddedCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        {mutedEntries.length === 0 ? (
          <Text style={[styles.emptyHint, { color: colors.textMuted }]}>
            非表示にしたサイトはありません
          </Text>
        ) : (
          mutedEntries.map((entry, idx) => (
            <View
              key={entry.siteId}
              style={[
                styles.subRow,
                idx === 0 ? { borderTopWidth: 0, paddingTop: 0 } : undefined,
                { borderTopColor: colors.border },
              ]}
            >
              <Text style={[styles.rowTitle, { color: colors.text }]}>
                {entry.name}
              </Text>
              <Pressable
                testID={`unmute-site-${entry.siteId}`}
                accessibilityRole="button"
                onPress={() => void unmuteSite(entry.siteId, entry.isCustom)}
                style={[
                  styles.smallBtn,
                  { backgroundColor: colors.accentSoft },
                ]}
              >
                <Text
                  style={[styles.smallBtnText, { color: colors.accentText }]}
                >
                  非表示を解除
                </Text>
              </Pressable>
            </View>
          ))
        )}
      </View>

      {/* Wi-Fi先読み・キャッシュ管理 */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        Wi-Fi先読み・キャッシュ管理
      </Text>
      <View
        style={[
          styles.card,
          styles.paddedCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.rowTitle, { color: colors.text }]}>
          通信状態: {wifiStatusLabel}
        </Text>
        <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
          先読みキャッシュ: {cacheEntries.length}件（合計{' '}
          {formatBytes(totalCacheBytes)}）
        </Text>

        <Text
          style={[
            styles.rowSubtitle,
            { color: colors.textSecondary, marginTop: 8, fontWeight: '600' },
          ]}
        >
          1回の先読み上限件数（現在: {prefetchBatchSize}件）
        </Text>
        <View style={styles.batchOptionRow}>
          {PREFETCH_BATCH_SIZE_OPTIONS.map((count) => {
            const selected = prefetchBatchSize === count;
            return (
              <Pressable
                key={count}
                testID={`prefetch-batch-option-${count}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => void setPrefetchBatchSize(count)}
                style={[
                  styles.batchChip,
                  {
                    backgroundColor: selected
                      ? colors.accent
                      : colors.surfaceSecondary,
                    borderColor: selected ? colors.accent : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.batchChipText,
                    { color: selected ? '#FFFFFF' : colors.text },
                  ]}
                >
                  {count}件
                </Text>
              </Pressable>
            );
          })}
        </View>
        {lastPrefetchResult ? (
          <Text style={[styles.rowSubtitle, { color: colors.textMuted }]}>
            直近の実行:{' '}
            {lastPrefetchResult.skippedNotWifi
              ? 'Wi-Fi未接続のためスキップ'
              : `${lastPrefetchResult.prefetchedCount}件先読み / ${lastPrefetchResult.purgedCacheCount}件期限切れ削除`}
          </Text>
        ) : null}

        <View style={styles.cacheBtnRow}>
          <Pressable
            testID="run-prefetch-button"
            accessibilityRole="button"
            onPress={() => void prefetchNow()}
            style={[
              styles.primaryBtn,
              styles.flexBtn,
              { backgroundColor: colors.accent },
            ]}
          >
            <Text style={styles.primaryBtnText}>
              {isPrefetching ? '先読み中…' : '今すぐWi-Fi先読みを実行'}
            </Text>
          </Pressable>

          <Pressable
            testID="clear-cache-button"
            accessibilityRole="button"
            onPress={() => void clearPrefetchCache()}
            style={[
              styles.primaryBtn,
              { backgroundColor: colors.dangerSoft },
            ]}
          >
            <Text style={[styles.clearBtnText, { color: colors.danger }]}>
              キャッシュを削除
            </Text>
          </Pressable>
        </View>

        <Pressable
          testID="open-benchmark-button"
          accessibilityRole="button"
          onPress={() => router.push('/benchmark' as Href)}
          style={[
            styles.primaryBtn,
            { backgroundColor: colors.accentSoft, marginTop: 8 },
          ]}
        >
          <Text style={[styles.clearBtnText, { color: colors.accentText }]}>
            先読み速度ベンチマークを計測する
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 36,
    paddingTop: 12,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  paddedCard: {
    padding: 14,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  rowTextCol: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 12,
    lineHeight: 17,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  inlineInputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  flexInput: {
    flex: 1,
  },
  primaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  clearBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  feedbackText: {
    fontSize: 13,
    fontWeight: '500',
  },
  subList: {
    marginTop: 4,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 10,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inlineBtns: {
    flexDirection: 'row',
    gap: 6,
  },
  smallBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  smallBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  emptyHint: {
    fontSize: 13,
  },
  cacheBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  flexBtn: {
    flex: 1,
  },
  batchOptionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
    marginBottom: 8,
  },
  batchChip: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  batchChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
