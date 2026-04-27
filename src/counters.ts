/**
 * Per-run counters. Threaded into run.ts, client, and extract for audit.
 *
 * Plain mutable object: callers increment in place. Read once at end of run
 * and copied into the audit payload. Keeping it plain (not a class) makes
 * it trivial to snapshot for tests and cheap to pass around.
 */

export interface RunCounters {
  /**
   * Number of work-bearing GraphQL requests issued through the shipreport
   * client. Excludes the trailing rate-limit probe and any uncounted
   * internal queries. Incremented only after a token has been resolved
   * and the request is about to leave the process; failures during the
   * network round-trip still count (a real call was attempted), but
   * pre-flight token-resolution failures do not (no call left this host).
   */
  apiCalls: number;
  /** Cumulative wall time spent sleeping because of rate-limit signals. */
  rateLimitSleepsMs: number;
  /**
   * PRs served from the extract cache rather than refetched. Exact count:
   * each merged-result PR whose (repo, number) was NOT freshly fetched
   * this run contributes 1.
   */
  cacheHits: number;
  /** Tasks in flight at the pool's peak. */
  peakConcurrency: number;
  /** Remaining GraphQL quota at end of run (null if never observed). */
  remainingRateLimit: number | null;
  /** Wall-clock duration of the run in ms. */
  wallMs: number;
}

export function createCounters(): RunCounters {
  return {
    apiCalls: 0,
    rateLimitSleepsMs: 0,
    cacheHits: 0,
    peakConcurrency: 0,
    remainingRateLimit: null,
    wallMs: 0,
  };
}
