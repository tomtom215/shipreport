import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cache } from "../src/cache.js";
import {
  ExtractCache,
  maxUpdatedAt,
  mergeByNumber,
  snapshotKey,
} from "../src/extract-cache.js";
import { quarterLabelToRange } from "../src/tz.js";
import type { RawPR } from "../src/types.js";

function rawPR(over: Partial<RawPR>): RawPR {
  return {
    repo: "o/r",
    number: 1,
    url: "u",
    title: "t",
    body: "",
    state: "MERGED",
    mergedAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
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
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewRequests: [],
    ...over,
  };
}

describe("snapshotKey", () => {
  it("includes repo, quarter label, and timezone", () => {
    const q = quarterLabelToRange("2026Q1", "America/New_York");
    expect(snapshotKey("o/r", q)).toBe("extract:o/r:2026Q1:America/New_York");
  });
});

describe("mergeByNumber", () => {
  it("fresh entries win over cached for the same (repo, number)", () => {
    const cached = [rawPR({ number: 1, title: "old" })];
    const fresh = [rawPR({ number: 1, title: "new" })];
    expect(mergeByNumber(cached, fresh)[0]!.title).toBe("new");
  });
  it("union of both sets, sorted by number", () => {
    const cached = [rawPR({ number: 5 }), rawPR({ number: 2 })];
    const fresh = [rawPR({ number: 3 })];
    expect(mergeByNumber(cached, fresh).map((p) => p.number)).toEqual([2, 3, 5]);
  });
});

describe("maxUpdatedAt", () => {
  it("returns the max across the list or the fallback", () => {
    const prs = [
      rawPR({ number: 1, updatedAt: "2026-02-01T00:00:00Z" }),
      rawPR({ number: 2, updatedAt: "2026-02-05T00:00:00Z" }),
    ];
    expect(maxUpdatedAt(prs)).toBe("2026-02-05T00:00:00Z");
    expect(maxUpdatedAt([], "2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
  });
});

describe("ExtractCache (SQLite round-trip)", () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-extract-cache-"));
    cache = await Cache.open(path.join(dir, "c.sqlite"), 7);
  });
  afterEach(async () => {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a snapshot verbatim", () => {
    const ec = new ExtractCache(cache);
    const q = quarterLabelToRange("2026Q1", "UTC");
    const prs = [rawPR({ number: 42, title: "x" })];
    ec.save("o/r", q, prs, "2026-02-01T00:00:00Z");
    const loaded = ec.load("o/r", q);
    expect(loaded?.prs[0]!.number).toBe(42);
    expect(loaded?.lastSeenUpdatedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("returns null for cold cache", () => {
    const ec = new ExtractCache(cache);
    const q = quarterLabelToRange("2026Q1", "UTC");
    expect(ec.load("o/r", q)).toBeNull();
  });

  it("separate quarters have separate snapshots", () => {
    const ec = new ExtractCache(cache);
    const q1 = quarterLabelToRange("2026Q1", "UTC");
    const q2 = quarterLabelToRange("2026Q2", "UTC");
    ec.save("o/r", q1, [rawPR({ number: 1 })], null);
    ec.save("o/r", q2, [rawPR({ number: 99 })], null);
    expect(ec.load("o/r", q1)!.prs[0]!.number).toBe(1);
    expect(ec.load("o/r", q2)!.prs[0]!.number).toBe(99);
  });
});
