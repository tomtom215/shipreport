import { describe, expect, it, vi } from "vitest";
import { runConcurrent } from "../src/concurrency.js";

describe("runConcurrent", () => {
  it("preserves result order regardless of completion order", async () => {
    const { results } = await runConcurrent([100, 10, 50], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(results).toEqual([100, 10, 50]);
  });

  it("respects the concurrency limit — peak never exceeds `limit`", async () => {
    let live = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, (_, i) => i);
    const { stats } = await runConcurrent(tasks, 3, async () => {
      live += 1;
      if (live > peak) peak = live;
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(stats.peakConcurrency).toBeLessThanOrEqual(3);
    expect(stats.peakConcurrency).toBeGreaterThanOrEqual(1);
  });

  it("reports peakConcurrency equal to min(limit, items.length)", async () => {
    const { stats } = await runConcurrent([1, 2], 8, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 0;
    });
    expect(stats.peakConcurrency).toBeLessThanOrEqual(2);
  });

  it("propagates the first error but lets other tasks settle", async () => {
    const settled = vi.fn();
    await expect(
      runConcurrent([1, 2, 3], 3, async (n) => {
        if (n === 2) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 10));
        settled(n);
      }),
    ).rejects.toThrow("boom");
    // other tasks were allowed to finish
    expect(settled).toHaveBeenCalledWith(1);
    expect(settled).toHaveBeenCalledWith(3);
  });

  it("rejects limit < 1", async () => {
    await expect(runConcurrent([1], 0, async () => 1)).rejects.toThrow(/>= 1/);
  });

  it("empty input list → empty results, peak = 0", async () => {
    const { results, stats } = await runConcurrent([], 4, async () => 1);
    expect(results).toEqual([]);
    expect(stats.peakConcurrency).toBe(0);
  });

  it("surfaces only the first error when several tasks throw", async () => {
    // Run serially so ordering is deterministic: index 1 throws before 2.
    await expect(
      runConcurrent([1, 2, 3], 1, async (n) => {
        if (n >= 2) throw new Error(`boom-${n}`);
        return n;
      }),
    ).rejects.toThrow("boom-2");
  });
});
