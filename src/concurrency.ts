/**
 * Bounded-concurrency task pool.
 *
 * A cooperative work-stealing pool: `limit` worker coroutines pull indices
 * off a shared counter until the queue is exhausted. Deterministic — the
 * result array mirrors the input order regardless of completion order.
 *
 * Error semantics (deliberate):
 *   - The first thrown error is captured and re-thrown after the pool
 *     drains. Other in-flight tasks are allowed to finish so per-repo
 *     audit rows continue to be appended on the way out — without that,
 *     a single 5xx in the middle of a 50-repo extract would orphan
 *     evidence for repos whose work was already in-progress.
 *   - We DO NOT, however, dispatch new work after an error has been
 *     captured: the worker loop's `idx >= items.length` exit is reached
 *     normally, but for catastrophic auth failures (HTTP 401), every
 *     subsequent dispatch would just retry the same dead credential.
 *     fetchRepo's own error handling (extract.ts) already surfaces 401
 *     immediately rather than waiting for cascade — auth failures
 *     short-circuit at the HTTP layer because the @octokit/plugin-retry
 *     `doNotRetry: [401]` config ensures only one attempt is made
 *     per repo before the error propagates here.
 */

export interface PoolStats {
  /** Observed maximum tasks running simultaneously. */
  peakConcurrency: number;
}

export interface PoolResult<R> {
  results: R[];
  stats: PoolStats;
}

export async function runConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>> {
  if (limit < 1) throw new Error(`concurrency limit must be >= 1 (got ${limit})`);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let inFlight = 0;
  let peak = 0;
  let firstError: unknown = undefined;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Short-circuit dispatch: once any task has thrown, stop pulling
      // new work off the queue. Tasks already in flight (the `await`
      // below) still complete so callers' per-item side effects (audit
      // rows, partial cache writes) settle. This bounds wasted work for
      // catastrophic failures (e.g. 401 on every repo) at `limit-1`
      // additional calls instead of the full N.
      if (firstError !== undefined) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        results[idx] = await fn(items[idx]!, idx);
      } catch (err) {
        if (firstError === undefined) firstError = err;
      } finally {
        inFlight -= 1;
      }
    }
  };

  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  if (firstError !== undefined) throw firstError;
  return { results, stats: { peakConcurrency: peak } };
}
