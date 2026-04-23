import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog } from "../src/audit.js";
import { Cache } from "../src/cache.js";
import { normalize } from "../src/config.js";
import { ExtractCache } from "../src/extract-cache.js";
import { auditLogFor, openState, runTeam, scheduleStoreFor } from "../src/run.js";
import { StateDB } from "../src/state.js";
import { quarterLabelToRange } from "../src/tz.js";
import type { RawPR } from "../src/types.js";

// Minimal valid RawPR.
const rawPR = (over: Partial<RawPR>): RawPR => ({
  repo: "tomtom215/shipreport",
  number: 1,
  url: "https://example/1",
  title: "feat: x",
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
});

describe("runTeam — dry-run UX", () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-run-"));
    // Scrub every token env var so any regression that reintroduces eager
    // auth resolution becomes visibly visible in this test.
    delete process.env.SHIPREPORT_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(dir, { recursive: true, force: true });
  });

  it("--dry-run runs with no token set, serves cached PRs, and produces a MD report", async () => {
    // Pre-seed the cache so the dry-run has something to serve.
    const cache = await Cache.open(path.join(dir, "cache.sqlite"), 7);
    const quarter = quarterLabelToRange("2026Q2", "UTC");
    new ExtractCache(cache).save(
      "tomtom215/shipreport",
      quarter,
      [rawPR({ author: "alice" }), rawPR({ number: 2, author: "alice" })],
      "2026-04-12T12:00:00Z",
    );
    cache.close();

    const cfg = normalize({
      github: {},
      org: "tomtom215",
      teams: [
        {
          name: "t",
          manager: "alice",
          members: ["alice"],
          repos: ["tomtom215/shipreport"],
        },
      ],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: false, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
    });

    const result = await runTeam({
      cfg,
      team: cfg.teams[0]!,
      log: () => {},
      triggeredBy: "manual",
      dryRun: true,
    });

    expect(result.counters.apiCalls).toBe(0);
    expect(result.counters.cacheHits).toBeGreaterThan(0);
    expect(result.written.some((p) => p.endsWith(".md"))).toBe(true);

    const md = await readFile(
      result.written.find((p) => p.includes("alice-"))!,
      "utf8",
    );
    expect(md).toMatch(/alice — 2026Q2 Success Story/);
  });

  it("dry-run with audit enabled writes run_started + run_completed + report_written rows and the chain verifies", async () => {
    const cache = await Cache.open(path.join(dir, "cache.sqlite"), 7);
    const quarter = quarterLabelToRange("2026Q2", "UTC");
    new ExtractCache(cache).save(
      "o/r",
      quarter,
      [rawPR({ repo: "o/r", author: "alice" })],
      "2026-04-12T12:00:00Z",
    );
    cache.close();

    const cfg = normalize({
      github: {},
      org: "o",
      teams: [
        { name: "t", manager: "alice", members: ["alice"], repos: ["o/r"] },
      ],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: true, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
    });

    const state = (await openState(cfg))!;
    const audit = auditLogFor(state);
    const result = await runTeam({
      cfg,
      team: cfg.teams[0]!,
      log: () => {},
      audit,
      triggeredBy: "manual",
      dryRun: true,
    });
    state.close();

    expect(result.counters.apiCalls).toBe(0);

    const state2 = (await openState(cfg))!;
    const audit2 = auditLogFor(state2);
    const events = audit2.tail(100).map((r) => r.event);
    expect(events).toContain("run_started");
    expect(events).toContain("run_completed");
    expect(events).toContain("report_written");
    // chain integrity
    expect(audit2.verify().ok).toBe(true);
    state2.close();
  });

  it("auto-discovers members when `members` is omitted; audits members_discovered", async () => {
    const cache = await Cache.open(path.join(dir, "cache.sqlite"), 7);
    const quarter = quarterLabelToRange("2026Q2", "UTC");
    new ExtractCache(cache).save(
      "o/r",
      quarter,
      [
        rawPR({ repo: "o/r", author: "alice", number: 1 }),
        rawPR({ repo: "o/r", author: "alice", number: 2 }),
        rawPR({ repo: "o/r", author: "bob", number: 3 }),
      ],
      "2026-04-12T12:00:00Z",
    );
    cache.close();

    const cfg = normalize({
      github: {},
      org: "o",
      teams: [
        // `members` omitted → auto-discover.
        { name: "t", manager: "alice", repos: ["o/r"] },
      ],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: true, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
    });

    const state = (await openState(cfg))!;
    const audit = auditLogFor(state);
    await runTeam({
      cfg,
      team: cfg.teams[0]!,
      log: () => {},
      audit,
      triggeredBy: "manual",
      dryRun: true,
    });
    state.close();

    const state2 = (await openState(cfg))!;
    const audit2 = auditLogFor(state2);
    const md = audit2.tail(100).find((r) => r.event === "members_discovered");
    state2.close();
    expect(md).toBeDefined();
    const payload = md!.payload as { members: string[] };
    expect(payload.members).toEqual(["alice", "bob"]);
  });
});

describe("run.ts helper exports", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-run-helpers-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("openState returns null when audit.enabled is false", async () => {
    const cfg = normalize({
      github: {},
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
      audit: { enabled: false, path: path.join(dir, "state.sqlite") },
    });
    expect(await openState(cfg)).toBeNull();
  });

  it("scheduleStoreFor and auditLogFor wrap a StateDB", async () => {
    const state = await StateDB.open(path.join(dir, "state.sqlite"));
    try {
      expect(scheduleStoreFor(state)).toBeDefined();
      expect(auditLogFor(state)).toBeInstanceOf(AuditLog);
    } finally {
      state.close();
    }
  });
});
