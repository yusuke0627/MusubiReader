export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_CONCURRENCY = 4;

/**
 * Executes a `fetch` request with an explicit timeout and `AbortController`
 * cancellation so stalled upstream servers cannot hang sync or prefetch queues.
 */
export async function fetchWithTimeout(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fetchPromise = Promise.resolve().then(() =>
    fetcher(url, { signal: controller.signal })
  );
  // Prevent unhandled rejection if timeout settles first and fetcher rejects later.
  fetchPromise.catch(() => {});

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Maps items through an async worker while capping in-flight concurrency.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
