import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cache } from "../src/cache.js";
import { createCounters } from "../src/counters.js";
import { extractAll } from "../src/extract.js";
import { ExtractCache } from "../src/extract-cache.js";
import type { GithubClient } from "../src/github.js";
import { quarterLabelToRange } from "../src/tz.js";

interface StubNode {
  number: number;
  baseRefName: string;
  mergedAt: string;
  updatedAt?: string;
  title?: string;
  body?: string;
  author?: string;
  coAuthorsCommitMessage?: string;
}

function stubClient(
  nodes: StubNode[],
  defaultBranch = "main",
): GithubClient & { calls: { count: number } } {
  const calls = { count: 0 };
  const gql = (async () => {
    calls.count += 1;
    // Mirror GitHub's ORDER_BY UPDATED_AT DESC so the incremental-break in
    // fetchRepo is exercised realistically.
    const sorted = [...nodes].sort((a, b) =>
      (b.updatedAt ?? b.mergedAt).localeCompare(a.updatedAt ?? a.mergedAt),
    );
    return {
      repository: {
        defaultBranchRef: { name: defaultBranch },
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: "x" },
          nodes: sorted.map((n) => ({
            number: n.number,
            title: n.title ?? "feat: thing",
            body: n.body ?? "",
            url: `https://example/${n.number}`,
            state: "MERGED",
            mergedAt: n.mergedAt,
            updatedAt: n.updatedAt ?? n.mergedAt,
            baseRefName: n.baseRefName,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            author: { login: n.author ?? "alice" },
            labels: { nodes: [] },
            milestone: null,
            comments: { totalCount: 0 },
            mergeCommit: { message: n.coAuthorsCommitMessage ?? null },
            reviews: { nodes: [] },
            reviewRequests: { nodes: [] },
            closingIssuesReferences: { nodes: [] },
          })),
        },
      },
    };
  }) as unknown as GithubClient["graphql"];
  return {
    graphql: gql,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rest: {} as any,
    baseUrl: "",
    async probeRemaining() {
      return 4999;
    },
    calls,
  };
}

describe("extractAll — default branch filter", () => {
  it("drops PRs whose base is not the repository's default branch", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const client = stubClient(
      [
        { number: 1, baseRefName: "main", mergedAt: "2026-02-10T00:00:00Z" },
        { number: 2, baseRefName: "release/1.0", mergedAt: "2026-02-11T00:00:00Z" },
        { number: 3, baseRefName: "main", mergedAt: "2026-02-12T00:00:00Z" },
      ],
      "main",
    );
    const res = await extractAll(client, { repos: ["o/r"] }, q);
    expect(res.prsByRepo.get("o/r")?.map((p) => p.number)).toEqual([1, 3]);
    expect(res.droppedNonDefaultBranch).toBe(1);
  });

  it("honors a non-'main' default branch name", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const client = stubClient(
      [
        { number: 10, baseRefName: "trunk", mergedAt: "2026-02-01T00:00:00Z" },
        { number: 11, baseRefName: "main", mergedAt: "2026-02-02T00:00:00Z" },
      ],
      "trunk",
    );
    const res = await extractAll(client, { repos: ["o/r"] }, q);
    expect(res.prsByRepo.get("o/r")?.map((p) => p.number)).toEqual([10]);
    expect(res.droppedNonDefaultBranch).toBe(1);
  });

  it("parses Co-authored-by trailers from the merge commit message", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const client = stubClient(
      [
        {
          number: 1,
          baseRefName: "main",
          mergedAt: "2026-02-10T00:00:00Z",
          author: "alice",
          coAuthorsCommitMessage:
            "subject\n\nCo-authored-by: Bob <7+bob@users.noreply.github.com>",
        },
      ],
      "main",
    );
    const res = await extractAll(client, { repos: ["o/r"] }, q);
    const pr = res.prsByRepo.get("o/r")![0]!;
    expect(pr.coAuthors).toEqual(["bob"]);
  });

  it("respects the timezone-aware window (PR merged inside NY-Q1 but outside UTC-Q1)", async () => {
    // 2026-01-01 02:00 UTC = 2025-12-31 21:00 EST — belongs to NY-2025Q4, not NY-2026Q1.
    // Pick an obvious inside-window time: 2026-01-01 10:00 UTC = 05:00 EST on Jan 1 → NY-Q1.
    const q = quarterLabelToRange("2026Q1", "America/New_York");
    const client = stubClient(
      [
        { number: 1, baseRefName: "main", mergedAt: "2026-01-01T02:00:00Z" },
        { number: 2, baseRefName: "main", mergedAt: "2026-01-01T10:00:00Z" },
      ],
      "main",
    );
    const res = await extractAll(client, { repos: ["o/r"] }, q);
    expect(res.prsByRepo.get("o/r")?.map((p) => p.number)).toEqual([2]);
  });
});

describe("extractAll — incremental cache", () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-extract-cache-it-"));
    cache = await Cache.open(path.join(dir, "c.sqlite"), 7);
  });
  afterEach(async () => {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("second run (no changes) hits ≥90% of PRs from cache and stops paginating early", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const ec = new ExtractCache(cache);
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      baseRefName: "main",
      mergedAt: `2026-02-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      updatedAt: `2026-02-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    }));
    const client = stubClient(nodes, "main");

    const c1 = createCounters();
    const r1 = await extractAll(
      client,
      { repos: ["o/r"] },
      q,
      { cache: ec, counters: c1 },
    );
    expect(r1.prsByRepo.get("o/r")).toHaveLength(20);
    expect(c1.cacheHits).toBe(0);
    const firstRunCalls = client.calls.count;

    const c2 = createCounters();
    const r2 = await extractAll(
      client,
      { repos: ["o/r"] },
      q,
      { cache: ec, counters: c2 },
    );
    expect(r2.prsByRepo.get("o/r")).toHaveLength(20);
    // Every PR should have come from cache on the second run.
    expect(c2.cacheHits).toBeGreaterThanOrEqual(Math.ceil(20 * 0.9));
    // And we shouldn't have made more API calls than we did on the cold run.
    expect(client.calls.count - firstRunCalls).toBeLessThanOrEqual(firstRunCalls);
  });

  it("incremental: a newly-updated PR is refetched, others served from cache", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const ec = new ExtractCache(cache);
    const base = [
      { number: 1, baseRefName: "main", mergedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { number: 2, baseRefName: "main", mergedAt: "2026-02-02T00:00:00Z", updatedAt: "2026-02-02T00:00:00Z" },
    ];
    const cold = stubClient(base, "main");
    await extractAll(cold, { repos: ["o/r"] }, q, { cache: ec });

    // PR #2 got edited; its updatedAt is now newer than anything cached.
    const warm = stubClient(
      [
        { number: 1, baseRefName: "main", mergedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
        { number: 2, baseRefName: "main", mergedAt: "2026-02-02T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", title: "edited title" },
      ],
      "main",
    );
    const c = createCounters();
    const res = await extractAll(warm, { repos: ["o/r"] }, q, { cache: ec, counters: c });
    const prs = res.prsByRepo.get("o/r")!;
    expect(prs.find((p) => p.number === 2)!.title).toBe("edited title");
    expect(c.cacheHits).toBe(1); // only PR #1 came from cache
  });
});

describe("extractAll — dry-run", () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-extract-dry-"));
    cache = await Cache.open(path.join(dir, "c.sqlite"), 7);
  });
  afterEach(async () => {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("throws loudly when the cache is cold (not recorded as a silent gap)", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const ec = new ExtractCache(cache);
    const client = stubClient([], "main");
    await expect(
      extractAll(client, { repos: ["o/r"] }, q, { cache: ec, dryRun: true }),
    ).rejects.toThrow(/no cached snapshot/);
  });

  it("serves cached PRs without any network calls and increments cacheHits", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const ec = new ExtractCache(cache);
    const nodes = [
      { number: 1, baseRefName: "main", mergedAt: "2026-02-01T00:00:00Z" },
      { number: 2, baseRefName: "main", mergedAt: "2026-02-05T00:00:00Z" },
    ];
    const warm = stubClient(nodes, "main");
    await extractAll(warm, { repos: ["o/r"] }, q, { cache: ec });

    const offline = stubClient([], "main");
    const c = createCounters();
    const res = await extractAll(
      offline,
      { repos: ["o/r"] },
      q,
      { cache: ec, counters: c, dryRun: true },
    );
    expect(res.prsByRepo.get("o/r")).toHaveLength(2);
    expect(offline.calls.count).toBe(0);
    expect(c.cacheHits).toBe(2);
  });
});

describe("extractAll — concurrency + counters", () => {
  it("reports peakConcurrency on counters (bounded by configured limit)", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const client = stubClient(
      [{ number: 1, baseRefName: "main", mergedAt: "2026-02-01T00:00:00Z" }],
      "main",
    );
    const c = createCounters();
    await extractAll(
      client,
      { repos: ["o/r1", "o/r2", "o/r3", "o/r4", "o/r5"] },
      q,
      { concurrency: 2, counters: c },
    );
    expect(c.peakConcurrency).toBeGreaterThanOrEqual(1);
    expect(c.peakConcurrency).toBeLessThanOrEqual(2);
  });
});
