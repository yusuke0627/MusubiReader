export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_CONCURRENCY = 4;

/**
 * Executes a `fetch` request with an explicit timeout and `AbortController`
 * cancellation so stalled upstream servers cannot hang sync or prefetch queues.
 */
export async function fetchWithTimeout(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  init?: RequestInit,
  externalSignal?: AbortSignal
): Promise<Response> {
  if (externalSignal?.aborted) {
    throw new Error(`Request aborted: ${url}`);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  const fetchPromise = Promise.resolve().then(() =>
    fetcher(url, { ...init, signal: controller.signal })
  );
  // Prevent unhandled rejection if timeout/abort settles first and fetcher rejects later.
  fetchPromise.catch(() => {});

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
  });

  const racers: Array<Promise<Response>> = [fetchPromise, timeoutPromise];

  if (externalSignal) {
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onExternalAbort = () => {
        controller.abort();
        reject(new Error(`Request aborted: ${url}`));
      };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    });
    racers.push(abortPromise);
  }

  try {
    return await Promise.race(racers);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Maps items through an async worker while capping in-flight concurrency.
 * Stops scheduling new work immediately when `signal` is aborted.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  if (items.length === 0 || signal?.aborted) {
    return [];
  }

  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length && !signal?.aborted) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
