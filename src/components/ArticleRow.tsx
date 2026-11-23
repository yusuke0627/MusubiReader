import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Article } from '../domain/types';
import { useThemeColors } from '../theme/tokens';

export interface ArticleRowProps {
  article: Article;
  matchedKeywords?: readonly string[];
  onPress: (article: Article) => void;
  onToggleSave: (article: Article) => void;
  onMuteSite?: (article: Article) => void;
  nowMs?: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats an epoch timestamp into a concise Japanese relative time string.
 */
export function formatRelativeTime(
  publishedAt: number,
  nowMs: number = Date.now()
): string {
  const diff = Math.max(0, nowMs - publishedAt);
  if (diff < MINUTE_MS) {
    return 'たった今';
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)}分前`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)}時間前`;
  }
  if (diff < 7 * DAY_MS) {
    return `${Math.floor(diff / DAY_MS)}日前`;
  }
  const date = new Date(publishedAt);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * Calm, readable article card with explicit Japanese labels and a safe action menu.
 */
export function ArticleRow({
  article,
  matchedKeywords,
  onPress,
  onToggleSave,
  onMuteSite,
  nowMs,
}: ArticleRowProps) {
  const colors = useThemeColors();
  const [menuOpen, setMenuOpen] = useState(false);

  const relativeTime = formatRelativeTime(article.publishedAt, nowMs);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
      ]}
    >
      <Pressable
        testID={`article-row-${article.id}`}
        onPress={() => onPress(article)}
        onLongPress={() => setMenuOpen((prev) => !prev)}
        style={({ pressed }) => [
          styles.mainArea,
          pressed ? styles.pressed : undefined,
        ]}
      >
        <View style={styles.metaRow}>
          <Text
            numberOfLines={1}
            style={[styles.metaText, { color: colors.textSecondary }]}
          >
            {article.siteName} ・ {relativeTime}
          </Text>
          <View style={styles.badgesRow}>
            {article.isPrefetched ? (
              <View
                testID={`article-prefetched-badge-${article.id}`}
                style={[
                  styles.badge,
                  { backgroundColor: colors.badgeSuccessBg },
                ]}
              >
                <Text
                  style={[styles.badgeText, { color: colors.badgeSuccessText }]}
                >
                  先読み済み
                </Text>
              </View>
            ) : null}
            {article.isSaved ? (
              <View
                style={[
                  styles.badge,
                  { backgroundColor: colors.badgeSavedBg },
                ]}
              >
                <Text
                  style={[styles.badgeText, { color: colors.badgeSavedText }]}
                >
                  ブックマーク
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <Text
          numberOfLines={2}
          style={[
            styles.title,
            { color: article.isRead ? colors.textMuted : colors.text },
          ]}
        >
          {article.title}
        </Text>

        {matchedKeywords && matchedKeywords.length > 0 ? (
          <View style={styles.keywordsRow}>
            {matchedKeywords.map((kw) => (
              <View
                key={kw}
                style={[
                  styles.keywordChip,
                  { backgroundColor: colors.accentSoft },
                ]}
              >
                <Text
                  style={[styles.keywordText, { color: colors.accentText }]}
                >
                  一致: {kw}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Pressable>

      <View style={styles.footerRow}>
        <Text style={[styles.categoryLabel, { color: colors.textMuted }]}>
          {article.category}
        </Text>
        <View style={styles.footerActions}>
          <Pressable
            testID={`article-bookmark-button-${article.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: article.isSaved }}
            accessibilityLabel={
              article.isSaved
                ? `${article.title}のブックマークを解除`
                : `${article.title}をブックマーク`
            }
            onPress={() => onToggleSave(article)}
            style={[
              styles.menuButton,
              {
                backgroundColor: article.isSaved
                  ? colors.badgeSavedBg
                  : colors.surfaceSecondary,
              },
            ]}
          >
            <Text
              style={[
                styles.menuButtonText,
                {
                  color: article.isSaved
                    ? colors.badgeSavedText
                    : colors.textSecondary,
                },
              ]}
            >
              {article.isSaved ? '★ ブックマーク済み' : '☆ ブックマーク'}
            </Text>
          </Pressable>
          <Pressable
            testID={`article-menu-button-${article.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${article.title}のメニュー`}
            onPress={() => setMenuOpen((prev) => !prev)}
            style={[
              styles.menuButton,
              {
                backgroundColor: menuOpen
                  ? colors.accentSoft
                  : colors.surfaceSecondary,
              },
            ]}
          >
            <Text
              style={[
                styles.menuButtonText,
                { color: menuOpen ? colors.accentText : colors.textSecondary },
              ]}
            >
              メニュー
            </Text>
          </Pressable>
        </View>
      </View>

      {menuOpen ? (
        <View
          style={[
            styles.actionBar,
            { borderTopColor: colors.border, backgroundColor: colors.background },
          ]}
        >
          <Pressable
            testID={`article-action-save-${article.id}`}
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              onToggleSave(article);
            }}
            style={[styles.actionBtn, { backgroundColor: colors.surface }]}
          >
            <Text style={[styles.actionBtnText, { color: colors.accentText }]}>
              {article.isSaved ? 'ブックマーク解除' : 'ブックマーク'}
            </Text>
          </Pressable>

          {onMuteSite ? (
            <Pressable
              testID={`article-action-mute-${article.id}`}
              accessibilityRole="button"
              onPress={() => {
                setMenuOpen(false);
                onMuteSite(article);
              }}
              style={[styles.actionBtn, { backgroundColor: colors.dangerSoft }]}
            >
              <Text style={[styles.actionBtnText, { color: colors.danger }]}>
                このサイトを非表示
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={() => setMenuOpen(false)}
            style={[
              styles.actionBtn,
              { backgroundColor: colors.surfaceSecondary },
            ]}
          >
            <Text
              style={[styles.actionBtnText, { color: colors.textSecondary }]}
            >
              閉じる
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 14,
    marginVertical: 5,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  mainArea: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  pressed: {
    opacity: 0.72,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  metaText: {
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  badgesRow: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  title: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
  },
  keywordsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  keywordChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  keywordText: {
    fontSize: 11,
    fontWeight: '600',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
    paddingTop: 2,
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  categoryLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  menuButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  menuButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  actionBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
