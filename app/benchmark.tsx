import { Stack } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  MusubiWebView,
  type MusubiWebViewLoadEndEvent,
} from '../modules/musubi-webview/src';
import {
  computeBenchmarkSummary,
  computePairMetrics,
  type BenchmarkSample,
} from '../src/domain/benchmark';
import type { Article } from '../src/domain/types';
import { useAppData } from '../src/state/app-context';
import { useThemeColors } from '../src/theme/tokens';

interface BenchmarkTarget {
  article: Article;
  localPath: string;
}

type RunMode = 'cache' | 'network';

interface ActiveRun {
  index: number;
  mode: RunMode;
  runKey: string;
  startedAtMs: number;
}

const MAX_BENCHMARK_ARTICLES = 3;

function formatNetworkLabel(type: string | undefined): string {
  switch (type) {
    case 'WIFI':
      return 'Wi-Fi';
    case 'CELLULAR':
      return '5G / モバイル通信';
    case 'NONE':
      return 'オフライン';
    default:
      return type ?? '不明';
  }
}

export default function BenchmarkScreen() {
  const colors = useThemeColors();
  const {
    cacheEntries,
    networkState,
    isPrefetching,
    getArticleById,
    prefetchNow,
    refreshNetworkState,
  } = useAppData();

  const [targets, setTargets] = useState<BenchmarkTarget[]>([]);
  const [isLoadingTargets, setIsLoadingTargets] = useState(true);
  const [samples, setSamples] = useState<BenchmarkSample[]>([]);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [runCounter, setRunCounter] = useState(0);

  const activeRunRef = useRef<ActiveRun | null>(null);
  activeRunRef.current = activeRun;
  const targetsRef = useRef<BenchmarkTarget[]>([]);
  targetsRef.current = targets;

  const networkLabel = useMemo(
    () => formatNetworkLabel(networkState?.type),
    [networkState]
  );

  const loadTargets = useCallback(async () => {
    setIsLoadingTargets(true);
    try {
      const resolved: BenchmarkTarget[] = [];
      for (const entry of cacheEntries) {
        if (resolved.length >= MAX_BENCHMARK_ARTICLES) {
          break;
        }
        const article = await getArticleById(entry.articleId);
        if (article) {
          resolved.push({ article, localPath: entry.localPath });
        }
      }
      setTargets(resolved);
    } finally {
      setIsLoadingTargets(false);
    }
  }, [cacheEntries, getArticleById]);

  useEffect(() => {
    void refreshNetworkState();
    void loadTargets();
  }, [refreshNetworkState, loadTargets]);

  const startBenchmark = useCallback(() => {
    if (targets.length === 0 || activeRun) {
      return;
    }
    const nextRunNumber = runCounter + 1;
    setRunCounter(nextRunNumber);
    setSamples(
      targets.map((t) => ({
        articleId: t.article.id,
        title: t.article.title,
        siteName: t.article.siteName,
        networkLabel,
        cacheMs: null,
        networkMs: null,
        cacheSuccess: false,
        networkSuccess: false,
      }))
    );
    setActiveRun({
      index: 0,
      mode: 'cache',
      runKey: `bench-${nextRunNumber}-0-cache`,
      startedAtMs: Date.now(),
    });
  }, [targets, activeRun, runCounter, networkLabel]);

  const handleLoadEnd = useCallback(
    (event: NativeSyntheticEvent<MusubiWebViewLoadEndEvent>) => {
      const current = activeRunRef.current;
      if (!current) {
        return;
      }
      const payload = event.nativeEvent;
      const measuredMs =
        typeof payload.durationMs === 'number' && payload.durationMs > 0
          ? payload.durationMs
          : Math.max(0, Date.now() - current.startedAtMs);

      setSamples((prev) =>
        prev.map((item, idx) => {
          if (idx !== current.index) {
            return item;
          }
          if (current.mode === 'cache') {
            return {
              ...item,
              cacheMs: measuredMs,
              cacheSuccess: Boolean(payload.success),
            };
          }
          return {
            ...item,
            networkMs: measuredMs,
            networkSuccess: Boolean(payload.success),
          };
        })
      );

      if (current.mode === 'cache') {
        setActiveRun({
          index: current.index,
          mode: 'network',
          runKey: `${current.runKey}-net`,
          startedAtMs: Date.now(),
        });
      } else {
        const nextIndex = current.index + 1;
        if (nextIndex < targetsRef.current.length) {
          setActiveRun({
            index: nextIndex,
            mode: 'cache',
            runKey: `bench-${runCounter}-${nextIndex}-cache`,
            startedAtMs: Date.now(),
          });
        } else {
          setActiveRun(null);
        }
      }
    },
    [runCounter]
  );

  const summary = useMemo(() => computeBenchmarkSummary(samples), [samples]);
  const activeTarget = activeRun ? targets[activeRun.index] : null;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen
        options={{ title: '先読み速度ベンチマーク', headerBackTitle: '戻る' }}
      />

      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.title, { color: colors.text }]}>
          先読みキャッシュ vs ネットワーク直読み
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          現在の回線: {networkLabel}（対象: 先読み済み {targets.length}件）
        </Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          同じ記事を「①先読みキャッシュ利用」と「②キャッシュ未使用（HTTPキャッシュ無視）」で連続計測します。Wi-Fi
          と 5G でそれぞれ測ると差が一目でわかります。
        </Text>

        <View style={styles.btnRow}>
          <Pressable
            testID="start-benchmark-button"
            accessibilityRole="button"
            disabled={targets.length === 0 || Boolean(activeRun)}
            onPress={startBenchmark}
            style={[
              styles.primaryBtn,
              {
                backgroundColor:
                  targets.length === 0 || activeRun
                    ? colors.border
                    : colors.accent,
              },
            ]}
          >
            <Text style={styles.primaryBtnText}>
              {activeRun
                ? `計測中 (${activeRun.index + 1}/${targets.length}: ${
                    activeRun.mode === 'cache' ? 'キャッシュ' : '直読み'
                  })…`
                : 'ベンチマークを開始'}
            </Text>
          </Pressable>

          {targets.length === 0 ? (
            <Pressable
              testID="benchmark-prefetch-button"
              accessibilityRole="button"
              disabled={isPrefetching}
              onPress={() => void prefetchNow()}
              style={[
                styles.secondaryBtn,
                { backgroundColor: colors.accentSoft },
              ]}
            >
              <Text
                style={[styles.secondaryBtnText, { color: colors.accentText }]}
              >
                {isPrefetching ? '先読み中…' : '先にWi-Fi先読みを実行'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {isLoadingTargets ? (
        <View style={styles.centerRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            先読み済み記事を確認中…
          </Text>
        </View>
      ) : null}

      {summary.completedPairs > 0 ? (
        <View
          testID="benchmark-summary-card"
          style={[
            styles.card,
            {
              backgroundColor: colors.badgeSuccessBg,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.title, { color: colors.badgeSuccessText }]}>
            計測サマリー（{summary.completedPairs}件平均・{networkLabel}）
          </Text>
          <Text style={[styles.metricLine, { color: colors.badgeSuccessText }]}>
            先読みキャッシュ平均: {summary.avgCacheMs} ms
          </Text>
          <Text style={[styles.metricLine, { color: colors.badgeSuccessText }]}>
            ネットワーク直読み平均: {summary.avgNetworkMs} ms
          </Text>
          <Text style={[styles.metricHighlight, { color: colors.badgeSuccessText }]}>
            短縮: {summary.avgSavedMs} ms
            {summary.speedupRatio !== null
              ? `（約 ${summary.speedupRatio} 倍速！）`
              : ''}
          </Text>
        </View>
      ) : null}

      {samples.map((sample) => {
        const pair = computePairMetrics(sample);
        return (
          <View
            key={sample.articleId}
            style={[
              styles.card,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text
              numberOfLines={2}
              style={[styles.sampleTitle, { color: colors.text }]}
            >
              {sample.title}
            </Text>
            <Text style={[styles.caption, { color: colors.textMuted }]}>
              {sample.siteName}
            </Text>
            <View style={styles.resultGrid}>
              <Text style={[styles.metricLine, { color: colors.text }]}>
                先読み利用:{' '}
                {sample.cacheMs !== null
                  ? `${sample.cacheMs} ms${sample.cacheSuccess ? '' : ' (失敗)'}`
                  : '計測待ち'}
              </Text>
              <Text style={[styles.metricLine, { color: colors.text }]}>
                直読み ({sample.networkLabel}):{' '}
                {sample.networkMs !== null
                  ? `${sample.networkMs} ms${sample.networkSuccess ? '' : ' (失敗)'}`
                  : '計測待ち'}
              </Text>
              {pair.savedMs !== null ? (
                <Text
                  style={[styles.metricHighlight, { color: colors.accentText }]}
                >
                  差分: {pair.savedMs >= 0 ? `-${pair.savedMs}` : `+${Math.abs(pair.savedMs)}`} ms
                  {pair.speedupRatio !== null ? `（${pair.speedupRatio}x）` : ''}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}

      {activeRun && activeTarget ? (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.caption, { color: colors.textSecondary }]}>
            計測用 WebView 実行中: {activeTarget.article.siteName}（
            {activeRun.mode === 'cache' ? '先読みキャッシュ' : 'ネットワーク直読み'}）
          </Text>
          <View style={styles.previewWebViewBox}>
            <MusubiWebView
              key={activeRun.runKey}
              style={styles.previewWebView}
              url={activeTarget.article.url}
              offlineHtmlPath={
                activeRun.mode === 'cache' ? activeTarget.localPath : null
              }
              adBlockEnabled={true}
              preferOfflineCache={activeRun.mode === 'cache'}
              ignoreHttpCache={activeRun.mode === 'network'}
              onLoadEnd={handleLoadEnd}
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 36,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 6,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  caption: {
    fontSize: 12,
    lineHeight: 18,
  },
  btnRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  primaryBtn: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryBtn: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  sampleTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  resultGrid: {
    marginTop: 4,
    gap: 3,
  },
  metricLine: {
    fontSize: 13,
    fontWeight: '500',
  },
  metricHighlight: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 2,
  },
  previewWebViewBox: {
    height: 180,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 6,
  },
  previewWebView: {
    flex: 1,
  },
});
