import {
  computeBenchmarkSummary,
  computePairMetrics,
  type BenchmarkSample,
} from '../benchmark';

describe('benchmark domain metrics', () => {
  test('computePairMetrics calculates savedMs and speedupRatio for valid pair', () => {
    const sample: BenchmarkSample = {
      articleId: 'a-1',
      title: 'テスト記事',
      siteName: 'IT速報',
      networkLabel: '5G / モバイル通信',
      cacheMs: 80,
      networkMs: 2400,
      cacheSuccess: true,
      networkSuccess: true,
    };

    expect(computePairMetrics(sample)).toEqual({
      savedMs: 2320,
      speedupRatio: 30,
    });
  });

  test('computePairMetrics returns nulls when either run failed or cacheMs is 0', () => {
    expect(
      computePairMetrics({
        articleId: 'a-2',
        title: '失敗',
        siteName: 'Site',
        networkLabel: 'Wi-Fi',
        cacheMs: 50,
        networkMs: null,
        cacheSuccess: true,
        networkSuccess: false,
      })
    ).toEqual({ savedMs: null, speedupRatio: null });

    expect(
      computePairMetrics({
        articleId: 'a-3',
        title: 'ゼロms',
        siteName: 'Site',
        networkLabel: 'Wi-Fi',
        cacheMs: 0,
        networkMs: 500,
        cacheSuccess: true,
        networkSuccess: true,
      })
    ).toEqual({ savedMs: 500, speedupRatio: null });
  });

  test('computeBenchmarkSummary aggregates averages across successful pairs only', () => {
    const samples: BenchmarkSample[] = [
      {
        articleId: 'a-1',
        title: '記事1',
        siteName: 'Site A',
        networkLabel: 'Wi-Fi',
        cacheMs: 100,
        networkMs: 1000,
        cacheSuccess: true,
        networkSuccess: true,
      },
      {
        articleId: 'a-2',
        title: '記事2',
        siteName: 'Site B',
        networkLabel: 'Wi-Fi',
        cacheMs: 200,
        networkMs: 2000,
        cacheSuccess: true,
        networkSuccess: true,
      },
      {
        articleId: 'a-3',
        title: '失敗記事',
        siteName: 'Site C',
        networkLabel: 'Wi-Fi',
        cacheMs: 50,
        networkMs: 9999,
        cacheSuccess: true,
        networkSuccess: false,
      },
    ];

    expect(computeBenchmarkSummary(samples)).toEqual({
      completedPairs: 2,
      avgCacheMs: 150,
      avgNetworkMs: 1500,
      avgSavedMs: 1350,
      speedupRatio: 10,
    });
  });

  test('computeBenchmarkSummary returns empty summary when no pairs succeeded', () => {
    expect(computeBenchmarkSummary([])).toEqual({
      completedPairs: 0,
      avgCacheMs: null,
      avgNetworkMs: null,
      avgSavedMs: null,
      speedupRatio: null,
    });
  });
});
