export interface BenchmarkSample {
  readonly articleId: string;
  readonly title: string;
  readonly siteName: string;
  readonly networkLabel: string;
  readonly cacheMs: number | null;
  readonly networkMs: number | null;
  readonly cacheSuccess: boolean;
  readonly networkSuccess: boolean;
}

export interface BenchmarkSummary {
  readonly completedPairs: number;
  readonly avgCacheMs: number | null;
  readonly avgNetworkMs: number | null;
  readonly avgSavedMs: number | null;
  readonly speedupRatio: number | null;
}

export function computePairMetrics(sample: BenchmarkSample): {
  savedMs: number | null;
  speedupRatio: number | null;
} {
  if (
    !sample.cacheSuccess ||
    !sample.networkSuccess ||
    sample.cacheMs === null ||
    sample.networkMs === null
  ) {
    return { savedMs: null, speedupRatio: null };
  }
  const savedMs = Math.round(sample.networkMs - sample.cacheMs);
  const speedupRatio =
    sample.cacheMs > 0
      ? Number((sample.networkMs / sample.cacheMs).toFixed(2))
      : null;
  return { savedMs, speedupRatio };
}

export function computeBenchmarkSummary(
  samples: readonly BenchmarkSample[]
): BenchmarkSummary {
  const valid = samples.filter(
    (s) =>
      s.cacheSuccess &&
      s.networkSuccess &&
      s.cacheMs !== null &&
      s.networkMs !== null
  );

  if (valid.length === 0) {
    return {
      completedPairs: 0,
      avgCacheMs: null,
      avgNetworkMs: null,
      avgSavedMs: null,
      speedupRatio: null,
    };
  }

  const totalCache = valid.reduce((sum, s) => sum + (s.cacheMs ?? 0), 0);
  const totalNetwork = valid.reduce((sum, s) => sum + (s.networkMs ?? 0), 0);
  const avgCacheMs = Math.round(totalCache / valid.length);
  const avgNetworkMs = Math.round(totalNetwork / valid.length);
  const avgSavedMs = avgNetworkMs - avgCacheMs;
  const speedupRatio =
    avgCacheMs > 0 ? Number((avgNetworkMs / avgCacheMs).toFixed(2)) : null;

  return {
    completedPairs: valid.length,
    avgCacheMs,
    avgNetworkMs,
    avgSavedMs,
    speedupRatio,
  };
}
