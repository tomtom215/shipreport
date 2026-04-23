/**
 * Rate-limit-aware concurrency guard.
 *
 * When observed GraphQL remaining quota drops below `threshold`, the guard
 * flips into degraded mode: subsequent work routed through gate() runs
 * serially (not concurrently), giving the quota a chance to recover and
 * preventing a thundering-herd kill at 0 remaining. The transition is
 * one-way within a run — once degraded, we stay degraded.
 *
 * observe() also re-enters safely on every GraphQL response; callers
 * don't need to throttle their observations.
 */

export interface RateLimitGuardOptions {
  threshold: number;
  onDegrade: (remaining: number) => void;
}

export class RateLimitGuard {
  private degraded = false;
  private serialTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RateLimitGuardOptions) {}

  /** Capture a remaining-quota reading; flip to degraded if below threshold. */
  observe(remaining: number | null | undefined): void {
    if (typeof remaining !== "number") return;
    if (!this.degraded && remaining < this.opts.threshold) {
      this.degraded = true;
      this.opts.onDegrade(remaining);
    }
  }

  /** Defensive probe for callers who want to branch without calling gate(). */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Run `fn`. In normal mode, runs immediately (no gating overhead). In
   * degraded mode, chained to a serial tail so only one gated work item
   * runs globally at a time.
   */
  async gate<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.degraded) return await fn();
    const prev = this.serialTail;
    let resolveMe: () => void;
    const next = new Promise<void>((r) => {
      resolveMe = r;
    });
    this.serialTail = next;
    try {
      await prev;
    } catch {
      /* prior work's error is its own; we still want to run */
    }
    try {
      return await fn();
    } finally {
      resolveMe!();
    }
  }
}
