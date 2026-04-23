/**
 * Bounded-concurrency task pool.
 *
 * A cooperative work-stealing pool: `limit` worker coroutines pull indices
 * off a shared counter until the queue is exhausted. Deterministic — the
 * result array mirrors the input order regardless of completion order.
 *
 * Errors propagate: if any task throws, the returned promise rejects with
 * that error. Other in-flight tasks are allowed to settle (we don't abort)
 * because our callers want partial audit data on failure.
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
