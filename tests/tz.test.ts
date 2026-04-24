import { describe, expect, it } from "vitest";
import {
  dateRangeToQuarter,
  quarterLabelToRange,
  tzOffsetMs,
  wallClockToUtcMs,
} from "../src/tz.js";

describe("tzOffsetMs", () => {
  it("returns 0 for UTC regardless of instant", () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12, 0, 0), "UTC")).toBe(0);
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12, 0, 0), "UTC")).toBe(0);
  });

  it("returns a negative offset for zones west of UTC (America/New_York in January)", () => {
    // EST = UTC-5, so wall − UTC = -5h = -18_000_000 ms.
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12, 0, 0), "America/New_York")).toBe(
      -5 * 60 * 60 * 1000,
    );
  });

  it("returns a positive offset for zones east of UTC (Asia/Tokyo)", () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12, 0, 0), "Asia/Tokyo")).toBe(
      9 * 60 * 60 * 1000,
    );
  });

  it("tracks DST: America/New_York is UTC-4 in July and UTC-5 in January", () => {
    const jan = tzOffsetMs(Date.UTC(2026, 0, 15, 12, 0, 0), "America/New_York");
    const jul = tzOffsetMs(Date.UTC(2026, 6, 15, 12, 0, 0), "America/New_York");
    expect(jul - jan).toBe(60 * 60 * 1000);
  });
});

describe("wallClockToUtcMs", () => {
  it("round-trips noon UTC on a non-DST day", () => {
    const ts = wallClockToUtcMs(2026, 1, 15, 12, 0, 0, "UTC");
    expect(ts).toBe(Date.UTC(2026, 0, 15, 12, 0, 0));
  });

  it("resolves 09:00 America/New_York in January as 14:00Z (UTC-5)", () => {
    const ts = wallClockToUtcMs(2026, 1, 15, 9, 0, 0, "America/New_York");
    expect(ts).toBe(Date.UTC(2026, 0, 15, 14, 0, 0));
  });

  it("resolves 09:00 America/New_York in July as 13:00Z (UTC-4, DST)", () => {
    const ts = wallClockToUtcMs(2026, 7, 15, 9, 0, 0, "America/New_York");
    expect(ts).toBe(Date.UTC(2026, 6, 15, 13, 0, 0));
  });
});

describe("quarterLabelToRange", () => {
  it("expands 2026Q1 to Jan 1 – Mar 31 inclusive in UTC", () => {
    const r = quarterLabelToRange("2026Q1", "UTC");
    expect(r.label).toBe("2026Q1");
    expect(r.from).toBe("2026-01-01");
    expect(r.to).toBe("2026-03-31");
    expect(r.fromTs).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(r.toTs).toBe(Date.UTC(2026, 2, 31, 23, 59, 59));
    expect(r.tz).toBe("UTC");
  });

  it("picks the correct end-of-month day for Q2 (June has 30 days)", () => {
    const r = quarterLabelToRange("2026Q2", "UTC");
    expect(r.to).toBe("2026-06-30");
  });

  it("picks the correct end-of-month day for Q4 of a leap year (Dec 31)", () => {
    const r = quarterLabelToRange("2024Q4", "UTC");
    expect(r.from).toBe("2024-10-01");
    expect(r.to).toBe("2024-12-31");
  });

  it("anchors the quarter to the configured timezone's wall-clock midnight", () => {
    const utc = quarterLabelToRange("2026Q1", "UTC");
    const nyc = quarterLabelToRange("2026Q1", "America/New_York");
    // NYC is west of UTC in January, so wall-clock Jan-1 00:00 NYC is 05:00Z.
    expect(nyc.fromTs - utc.fromTs).toBe(5 * 60 * 60 * 1000);
  });

  it("rejects a malformed label", () => {
    expect(() => quarterLabelToRange("2026-Q1", "UTC")).toThrow(/bad quarter label/);
    expect(() => quarterLabelToRange("2026Q5", "UTC")).toThrow(/bad quarter label/);
    expect(() => quarterLabelToRange("", "UTC")).toThrow(/bad quarter label/);
  });
});

describe("dateRangeToQuarter", () => {
  it("produces a range label from the two ISO dates and resolves tz bounds", () => {
    const r = dateRangeToQuarter("2026-01-01", "2026-03-31", "UTC");
    expect(r.label).toBe("2026-01-01..2026-03-31");
    expect(r.fromTs).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(r.toTs).toBe(Date.UTC(2026, 2, 31, 23, 59, 59));
  });

  it("rejects a malformed 'from' date", () => {
    expect(() => dateRangeToQuarter("2026/01/01", "2026-03-31", "UTC")).toThrow(
      /bad date/,
    );
  });

  it("rejects a malformed 'to' date", () => {
    expect(() => dateRangeToQuarter("2026-01-01", "not-a-date", "UTC")).toThrow(
      /bad date/,
    );
  });
});
