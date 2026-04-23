import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cache } from "../src/cache.js";
import { normalize } from "../src/config.js";
import { ExtractCache } from "../src/extract-cache.js";
import { runTeam } from "../src/run.js";
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
});
