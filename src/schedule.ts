import type { StateDB } from "./state.js";

/**
 * Minimal 5-field cron parser.
 *
 * Supports: `*`, integer, `a,b,c`, `a-b`, `*\/n`, and `a-b/n`.
 * Fields are: minute hour day-of-month month day-of-week (0=Sunday).
 *
 * We do NOT support @yearly, L/W/#, nicknames, seconds. If you need those,
 * switch to node-cron — but for once-a-quarter reports this handles the
 * realistic cases (daily, weekly, quarterly).
 */
export interface CronSpec {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

const RANGES: Array<[keyof CronSpec, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 6],
];

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
  }
  const out = {} as CronSpec;
  for (let i = 0; i < 5; i++) {
    const [field, lo, hi] = RANGES[i]!;
    out[field] = expandField(parts[i]!, lo, hi, expr, field);
  }
  return out;
}

function expandField(src: string, lo: number, hi: number, expr: string, field: string): number[] {
  const pieces = src.split(",");
  const result = new Set<number>();
  for (const piece of pieces) {
    let range = piece;
    let step = 1;
    const slash = piece.indexOf("/");
    if (slash !== -1) {
      step = Number(piece.slice(slash + 1));
      range = piece.slice(0, slash);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Bad step in "${expr}" field ${field}: ${piece}`);
      }
    }
    let start: number;
    let end: number;
    if (range === "*") {
      start = lo;
      end = hi;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Bad range in "${expr}" field ${field}: ${piece}`);
      }
      start = a!;
      end = b!;
    } else {
      const v = Number(range);
      if (!Number.isInteger(v)) {
        throw new Error(`Bad value in "${expr}" field ${field}: ${piece}`);
      }
      start = v;
      end = v;
    }
    if (start < lo || end > hi || start > end) {
      throw new Error(`Out of range in "${expr}" field ${field}: ${piece} (allowed ${lo}-${hi})`);
    }
    for (let n = start; n <= end; n += step) result.add(n);
  }
  return [...result].sort((a, b) => a - b);
}

export function cronMatches(spec: CronSpec, at: Date): boolean {
  return (
    spec.minute.includes(at.getUTCMinutes()) &&
    spec.hour.includes(at.getUTCHours()) &&
    spec.dom.includes(at.getUTCDate()) &&
    spec.month.includes(at.getUTCMonth() + 1) &&
    spec.dow.includes(at.getUTCDay())
  );
}

/**
 * Is a team due to run?
 *
 * A team is due if:
 *   (a) it has a schedule, AND
 *   (b) there is a minute between lastRun and now that matches the cron.
 *
 * Cost model. The scan is O(minutes-since-last-run), capped at
 * `maxScanMinutes` (default 365 days = 525,600 iterations). Each
 * iteration is a `Date` allocation plus four `includes` lookups; on
 * Node 24 that's ~10-12 ns per loop, so the absolute worst case (a
 * year-stale `lastRunAt` running on a tiny ARM box) lands in the
 * 5-10 ms range. Realistic shapes — quarterly cron with hourly tick,
 * recently-run teams — finish in microseconds. The cap exists so a
 * pathologically stale state DB can't pin a CI runner for hours; it
 * is NOT a recovery boundary, since `cronMatches` is itself stateless
 * and re-checks fire normally on subsequent ticks.
 */
export function isDueSince(
  spec: CronSpec,
  lastRunIso: string | null,
  now: Date,
  opts: { maxScanMinutes?: number } = {},
): boolean {
  const MAX = opts.maxScanMinutes ?? 365 * 24 * 60;
  const nowUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes(), 0, 0,
  ));
  const last = lastRunIso ? new Date(lastRunIso).getTime() : 0;

  // Scan minute-by-minute from max(last+1, now-MAX) through now.
  const start = Math.max(last + 60 * 1000, nowUtc.getTime() - MAX * 60 * 1000);
  for (let t = start; t <= nowUtc.getTime(); t += 60 * 1000) {
    const when = new Date(t);
    if (cronMatches(spec, when)) return true;
  }
  return false;
}

export interface ScheduleRecord {
  team: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastQuarter: string | null;
}

export class ScheduleStore {
  constructor(private readonly state: StateDB) {}

  get(team: string): ScheduleRecord {
    const row = this.state.db
      .prepare(
        `SELECT team, last_run_at, last_status, last_quarter FROM schedule_state WHERE team = ?`,
      )
      .get(team) as
      | { team: string; last_run_at: string; last_status: string; last_quarter: string | null }
      | undefined;
    if (!row) return { team, lastRunAt: null, lastStatus: null, lastQuarter: null };
    return {
      team: row.team,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastQuarter: row.last_quarter,
    };
  }

  record(team: string, status: "ok" | "failed", quarter: string | null): void {
    const at = new Date().toISOString();
    this.state.db
      .prepare(
        `INSERT INTO schedule_state (team, last_run_at, last_status, last_quarter)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(team) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_status = excluded.last_status,
           last_quarter = excluded.last_quarter`,
      )
      .run(team, at, status, quarter);
  }
}
