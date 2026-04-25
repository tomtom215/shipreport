/**
 * Timezone-aware quarter boundaries.
 *
 * The previous implementation hard-coded UTC midnight, which silently
 * mis-attributed PRs merged near quarter boundaries when a team operated in
 * a non-UTC zone. `Intl.DateTimeFormat` is the only stdlib tool that knows
 * about DST transitions and zone offsets, so we use it to resolve a wall-
 * clock time in the configured zone to an absolute unix timestamp.
 */

import type { QuarterRange } from "./types.js";

/**
 * Return the offset (in ms, wall-clock − UTC) that the given timezone had
 * at the given UTC instant. Positive for zones east of UTC.
 */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string): number =>
    /* c8 ignore next — defensive `?? "0"` for an Intl response missing
       a part; in practice Intl always emits all requested fields. */
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Intl sometimes reports "24" for midnight; normalise.
  const h = get("hour");
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    /* c8 ignore next — Node 24 normalises "24" upstream; guarded for older Intl impls. */
    h === 24 ? 0 : h,
    get("minute"),
    get("second"),
  );
  return wall - utcMs;
}

/**
 * Resolve a wall-clock time in the given zone to an absolute unix timestamp.
 * Two passes because DST transitions mean the offset at the *result* can
 * differ from the offset at the initial guess; one correction round is
 * enough for every real-world zone.
 */
export function wallClockToUtcMs(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month1 - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(guess, tz);
  const corrected = guess - off1;
  const off2 = tzOffsetMs(corrected, tz);
  return guess - off2;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function lastDayOfMonth(year: number, month1: number): number {
  // Day 0 of the *next* month is the last day of this month in UTC, which is
  // fine because we're working with the calendar day only.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function quarterLabelToRange(label: string, tz: string): QuarterRange {
  const m = /^(\d{4})Q([1-4])$/.exec(label);
  if (!m) throw new Error(`bad quarter label: ${label}`);
  const year = Number(m[1]);
  const qi = Number(m[2]);
  const startMonth = (qi - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const endDay = lastDayOfMonth(year, endMonth);
  const from = `${year}-${pad2(startMonth)}-01`;
  const to = `${year}-${pad2(endMonth)}-${pad2(endDay)}`;
  const fromTs = wallClockToUtcMs(year, startMonth, 1, 0, 0, 0, tz);
  const toTs = wallClockToUtcMs(year, endMonth, endDay, 23, 59, 59, tz);
  return { label, from, to, fromTs, toTs, tz };
}

export function dateRangeToQuarter(
  from: string,
  to: string,
  tz: string,
): QuarterRange {
  const parse = (iso: string): [number, number, number] => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) throw new Error(`bad date: ${iso}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [fy, fm, fd] = parse(from);
  const [ty, tm, td] = parse(to);
  return {
    label: `${from}..${to}`,
    from,
    to,
    fromTs: wallClockToUtcMs(fy, fm, fd, 0, 0, 0, tz),
    toTs: wallClockToUtcMs(ty, tm, td, 23, 59, 59, tz),
    tz,
  };
}
