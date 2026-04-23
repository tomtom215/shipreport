/**
 * Per-(repo, quarter, tz) snapshot cache for extractAll.
 *
 * Stores the full list of RawPR objects so that a re-run can ship them
 * back without any network calls for unchanged PRs. The cache key
 * includes the timezone because the quarter-window's absolute bounds
 * change with tz, and we don't want a tz edit to silently reuse a stale
 * window.
 *
 * Snapshot schema v1. If the shape ever changes we bump SCHEMA_VERSION
 * and older snapshots are treated as cold (they will be repopulated).
 */

import type { Cache } from "./cache.js";
import type { QuarterRange, RawPR } from "./types.js";

const SCHEMA_VERSION = 1;

export interface ExtractSnapshot {
  schemaVersion: number;
  repo: string;
  quarterLabel: string;
  tz: string;
  /** Max updatedAt we've ever seen in this window, ISO-8601. */
  lastSeenUpdatedAt: string | null;
  prs: RawPR[];
}

export function snapshotKey(repo: string, quarter: QuarterRange): string {
  return `extract:${repo}:${quarter.label}:${quarter.tz}`;
}

export class ExtractCache {
  constructor(private readonly cache: Cache) {}

  load(repo: string, quarter: QuarterRange): ExtractSnapshot | null {
    const row = this.cache.getExtractSnapshot(snapshotKey(repo, quarter));
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.body) as ExtractSnapshot;
      if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(
    repo: string,
    quarter: QuarterRange,
    prs: RawPR[],
    lastSeenUpdatedAt: string | null,
  ): void {
    const snapshot: ExtractSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      repo,
      quarterLabel: quarter.label,
      tz: quarter.tz,
      lastSeenUpdatedAt,
      prs,
    };
    this.cache.setExtractSnapshot(snapshotKey(repo, quarter), JSON.stringify(snapshot));
  }
}

/**
 * Merge freshly-fetched PRs into a cached set, keyed by (repo, number).
 * Newer entries win. Returns the merged list sorted deterministically.
 */
export function mergeByNumber(cached: RawPR[], fresh: RawPR[]): RawPR[] {
  const byKey = new Map<string, RawPR>();
  for (const p of cached) byKey.set(`${p.repo}#${p.number}`, p);
  for (const p of fresh) byKey.set(`${p.repo}#${p.number}`, p);
  return [...byKey.values()].sort((a, b) => a.number - b.number);
}

/** Highest updatedAt across a list, or the fallback if the list is empty. */
export function maxUpdatedAt(prs: RawPR[], fallback: string | null = null): string | null {
  let best: string | null = fallback;
  for (const p of prs) {
    if (p.updatedAt && (!best || p.updatedAt > best)) best = p.updatedAt;
  }
  return best;
}
