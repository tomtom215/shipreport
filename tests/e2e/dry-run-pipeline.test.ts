/**
 * End-to-end test of the full `shipreport run --dryRun` pipeline.
 *
 * Drives runTeam() with a hand-built shipreport.yaml-equivalent config, a
 * pre-warmed extract cache, and an enabled audit log. Asserts:
 *   * every persistable output format we ship gets written for a multi-
 *     dev team,
 *   * audit chain is complete and verifies after the run,
 *   * dry-run mode never resolves a token (no token_resolved row),
 *   * scheduler state advances after a successful run via record(),
 *   * a second back-to-back run is idempotent on the cache.
 *
 * No network. No `pnpm build` dependency. Pure ts-only execution under
 * vitest, like every other test file.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cache } from "../../src/cache.js";
import { normalize } from "../../src/config.js";
import { ExtractCache } from "../../src/extract-cache.js";
import { auditLogFor, openState, runTeam, scheduleStoreFor } from "../../src/run.js";
import { quarterLabelToRange } from "../../src/tz.js";
import type { RawPR } from "../../src/types.js";

function rawPR(over: Partial<RawPR>): RawPR {
  return {
    repo: "o/r",
    number: 1,
    url: "https://example/1",
    title: "feat: thing",
    body: "",
    state: "MERGED",
    mergedAt: "2026-04-12T12:00:00Z",
    updatedAt: "2026-04-12T12:00:00Z",
    author: "alice",
    coAuthors: [],
    baseRefName: "main",
    defaultBranch: "main",
    mergeCommitMessage: null,
    labels: [],
    milestone: null,
    reviews: [],
    comments: 0,
    linkedIssues: [],
    additions: 10,
    deletions: 1,
    changedFiles: 1,
    reviewRequests: [],
    ...over,
  };
}

describe("E2E: full dry-run pipeline", () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-e2e-"));
    delete process.env.SHIPREPORT_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(dir, { recursive: true, force: true });
  });

  it("warm cache → dry-run renders md+html for 2 devs + team summary + manager rollup; chain verifies; tokens never touched", async () => {
    // 1. Warm the extract cache directly.
    const cache = await Cache.open(path.join(dir, "cache.sqlite"), 7);
    const quarter = quarterLabelToRange("2026Q2", "UTC");
    new ExtractCache(cache).save(
      "o/r",
      quarter,
      [
        rawPR({ author: "alice", number: 1 }),
        rawPR({ author: "alice", number: 2, mergedAt: "2026-04-15T12:00:00Z", updatedAt: "2026-04-15T12:00:00Z" }),
        rawPR({ author: "bob", number: 3, mergedAt: "2026-04-20T12:00:00Z", updatedAt: "2026-04-20T12:00:00Z" }),
      ],
      "2026-04-20T12:00:00Z",
    );
    cache.close();

    // 2. Build a config with audit on, formats md+html.
    const cfg = normalize({
      github: {},
      org: "o",
      teams: [
        {
          name: "checkout",
          manager: "alice",
          members: ["alice", "bob"],
          repos: ["o/r"],
          schedule: "0 14 1 1,4,7,10 *",
        },
      ],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: {
          dir: path.join(dir, "out"),
          formats: ["md", "html"],
          perDev: true,
          teamSummary: true,
          managerRollup: true,
        },
      },
      audit: { enabled: true, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
    });

    const state = (await openState(cfg))!;
    const audit = auditLogFor(state);
    const sched = scheduleStoreFor(state);
    const result = await runTeam({
      cfg,
      team: cfg.teams[0]!,
      log: () => {},
      audit,
      triggeredBy: "schedule",
      dryRun: true,
    });
    sched.record(cfg.teams[0]!.name, "ok", result.quarter);

    // 3. Asserts on outputs:
    // 2 devs × (md + html) + team-summary × 2 + manager-rollup × 2 = 8.
    expect(result.written).toHaveLength(8);
    expect(result.written.filter((p) => p.endsWith(".md"))).toHaveLength(4);
    expect(result.written.filter((p) => p.endsWith(".html"))).toHaveLength(4);

    const aliceMd = await readFile(
      result.written.find((p) => p.endsWith("alice-2026Q2.md"))!,
      "utf8",
    );
    expect(aliceMd).toMatch(/alice/);
    const rollupMd = await readFile(
      result.written.find((p) => p.endsWith("manager-rollup-checkout-2026Q2.md"))!,
      "utf8",
    );
    expect(rollupMd.length).toBeGreaterThan(100);

    // 4. Audit chain verifies.
    const v = audit.verify();
    expect(v.ok).toBe(true);

    // 5. Dry-run never resolves a token.
    const events = audit.tail(100).map((r) => r.event);
    expect(events).not.toContain("token_resolved");
    expect(events).toContain("run_started");
    expect(events).toContain("run_completed");
    expect(events).toContain("report_written");

    // 6. Counter sanity.
    expect(result.counters.apiCalls).toBe(0);
    expect(result.counters.cacheHits).toBeGreaterThan(0);

    // 7. Schedule state was recorded.
    const rec = sched.get(cfg.teams[0]!.name);
    expect(rec.lastStatus).toBe("ok");
    expect(rec.lastQuarter).toBe("2026Q2");
    expect(rec.lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    state.close();
  });

  it("two back-to-back dry-runs produce identical outputs and append a fresh audit chain prefix", async () => {
    const cache = await Cache.open(path.join(dir, "cache.sqlite"), 7);
    const quarter = quarterLabelToRange("2026Q2", "UTC");
    new ExtractCache(cache).save(
      "o/r",
      quarter,
      [rawPR({ author: "alice", number: 1 })],
      "2026-04-12T12:00:00Z",
    );
    cache.close();

    const cfg = normalize({
      github: {},
      org: "o",
      teams: [{ name: "t", manager: "alice", members: ["alice"], repos: ["o/r"] }],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: true, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
    });

    const runOnce = async (): Promise<string> => {
      const s = (await openState(cfg))!;
      const a = auditLogFor(s);
      const r = await runTeam({
        cfg,
        team: cfg.teams[0]!,
        log: () => {},
        audit: a,
        triggeredBy: "manual",
        dryRun: true,
      });
      const md = await readFile(r.written.find((p) => p.endsWith(".md"))!, "utf8");
      s.close();
      return md;
    };

    const md1 = await runOnce();
    const md2 = await runOnce();
    // Templates use generatedAt + timestamp; strip the line that varies.
    const stripVolatile = (s: string): string =>
      s.replace(/Generated by shipreport[^\n]*/g, "")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<TS>");
    expect(stripVolatile(md1)).toBe(stripVolatile(md2));

    // Chain has events from both runs and still verifies.
    const s = (await openState(cfg))!;
    const a = auditLogFor(s);
    const events = a.tail(100).map((r) => r.event);
    expect(events.filter((e) => e === "run_started").length).toBe(2);
    expect(events.filter((e) => e === "run_completed").length).toBe(2);
    expect(a.verify().ok).toBe(true);
    s.close();
  });

  it("cold-cache dry-run fails loudly with a remediation message", async () => {
    const cfg = normalize({
      github: {},
      org: "o",
      teams: [{ name: "t", manager: "alice", members: ["alice"], repos: ["o/r"] }],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: false, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
    });

    await expect(
      runTeam({
        cfg,
        team: cfg.teams[0]!,
        log: () => {},
        triggeredBy: "manual",
        dryRun: true,
      }),
    ).rejects.toThrow(/no cached snapshot/i);
  });
});
