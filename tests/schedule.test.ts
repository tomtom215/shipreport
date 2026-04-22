import { describe, expect, it } from "vitest";
import { cronMatches, isDueSince, parseCron, ScheduleStore } from "../src/schedule.js";
import { StateDB } from "../src/state.js";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("parseCron", () => {
  it("accepts 5 fields", () => {
    const s = parseCron("0 14 1 1,4,7,10 *");
    expect(s.minute).toEqual([0]);
    expect(s.hour).toEqual([14]);
    expect(s.dom).toEqual([1]);
    expect(s.month).toEqual([1, 4, 7, 10]);
    expect(s.dow).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("expands *", () => {
    expect(parseCron("* * * * *").minute).toHaveLength(60);
  });

  it("expands step", () => {
    expect(parseCron("*/15 * * * *").minute).toEqual([0, 15, 30, 45]);
  });

  it("expands ranges and combos", () => {
    expect(parseCron("0 9-11 * * 1-5").hour).toEqual([9, 10, 11]);
    expect(parseCron("0 9-11 * * 1-5").dow).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("* * * * * *")).toThrow();
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 25 * * *")).toThrow();
  });
});

describe("cronMatches", () => {
  it("matches the exact minute", () => {
    const s = parseCron("0 14 1 1 *");
    expect(cronMatches(s, new Date(Date.UTC(2026, 0, 1, 14, 0)))).toBe(true);
    expect(cronMatches(s, new Date(Date.UTC(2026, 0, 1, 14, 1)))).toBe(false);
    expect(cronMatches(s, new Date(Date.UTC(2026, 0, 2, 14, 0)))).toBe(false);
  });
});

describe("isDueSince", () => {
  const quarterly = parseCron("0 14 1 1,4,7,10 *");

  it("is due when a matching minute passed since lastRun", () => {
    // lastRun just before Q2 trigger, now after it.
    const lastRun = "2026-03-31T00:00:00Z";
    const now = new Date(Date.UTC(2026, 3, 1, 15, 0)); // Apr 1 15:00
    expect(isDueSince(quarterly, lastRun, now)).toBe(true);
  });

  it("is not due if the cron didn't fire since lastRun", () => {
    const lastRun = "2026-04-01T14:00:00Z"; // the Q2 firing
    const now = new Date(Date.UTC(2026, 4, 15, 9, 0)); // May 15
    expect(isDueSince(quarterly, lastRun, now)).toBe(false);
  });

  it("treats null lastRun as due if any matching minute is within the scan window", () => {
    const daily = parseCron("0 0 * * *");
    const now = new Date(Date.UTC(2026, 1, 2, 1, 0));
    expect(isDueSince(daily, null, now)).toBe(true);
  });
});

describe("ScheduleStore", () => {
  async function freshStore(): Promise<{ s: ScheduleStore; state: StateDB }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-sched-"));
    const state = await StateDB.open(path.join(dir, "s.sqlite"));
    return { s: new ScheduleStore(state), state };
  }

  it("unknown team → null lastRunAt", async () => {
    const { s, state } = await freshStore();
    const r = s.get("nope");
    expect(r.lastRunAt).toBeNull();
    state.close();
  });

  it("record + get round-trips", async () => {
    const { s, state } = await freshStore();
    s.record("alpha", "ok", "2026Q1");
    const r = s.get("alpha");
    expect(r.lastStatus).toBe("ok");
    expect(r.lastQuarter).toBe("2026Q1");
    expect(r.lastRunAt).toBeTruthy();
    state.close();
  });

  it("record replaces prior value", async () => {
    const { s, state } = await freshStore();
    s.record("alpha", "failed", null);
    s.record("alpha", "ok", "2026Q2");
    const r = s.get("alpha");
    expect(r.lastStatus).toBe("ok");
    expect(r.lastQuarter).toBe("2026Q2");
    state.close();
  });
});
