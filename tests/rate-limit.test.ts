import { describe, expect, it, vi } from "vitest";
import { RateLimitGuard } from "../src/rate-limit.js";

describe("RateLimitGuard", () => {
  it("stays healthy while remaining > threshold", async () => {
    const onDegrade = vi.fn();
    const g = new RateLimitGuard({ threshold: 100, onDegrade });
    g.observe(5000);
    g.observe(101);
    expect(g.isDegraded).toBe(false);
    expect(onDegrade).not.toHaveBeenCalled();
    // gate() is a straight pass-through in healthy mode.
    expect(await g.gate(async () => 42)).toBe(42);
  });

  it("flips exactly once when remaining drops below threshold", async () => {
    const onDegrade = vi.fn();
    const g = new RateLimitGuard({ threshold: 100, onDegrade });
    g.observe(50); // first degrade
    g.observe(10); // already degraded
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(onDegrade).toHaveBeenCalledWith(50);
    expect(g.isDegraded).toBe(true);
  });

  it("ignores null/undefined readings", () => {
    const onDegrade = vi.fn();
    const g = new RateLimitGuard({ threshold: 100, onDegrade });
    g.observe(null);
    g.observe(undefined);
    expect(g.isDegraded).toBe(false);
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("serializes gated work after degrading", async () => {
    const onDegrade = vi.fn();
    const g = new RateLimitGuard({ threshold: 100, onDegrade });
    g.observe(5); // degrade

    let live = 0;
    let peak = 0;
    const task = async (ms: number): Promise<number> => {
      live += 1;
      if (live > peak) peak = live;
      await new Promise((r) => setTimeout(r, ms));
      live -= 1;
      return ms;
    };

    const results = await Promise.all([
      g.gate(() => task(30)),
      g.gate(() => task(10)),
      g.gate(() => task(20)),
    ]);
    expect(results).toEqual([30, 10, 20]);
    expect(peak).toBe(1); // never more than one gated task live at a time
  });

  it("does not hold back unrelated concurrency in healthy mode", async () => {
    const g = new RateLimitGuard({ threshold: 100, onDegrade: () => {} });
    let live = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      live += 1;
      if (live > peak) peak = live;
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    };
    await Promise.all([g.gate(task), g.gate(task), g.gate(task)]);
    expect(peak).toBeGreaterThan(1);
  });
});
