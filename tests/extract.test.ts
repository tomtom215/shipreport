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

describe("extractAll — checkpoint resume", () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-extract-checkpoint-"));
    cache = await Cache.open(path.join(dir, "c.sqlite"), 7);
  });
  afterEach(async () => {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists a checkpoint after each page; resumes from it after a failure", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const ec = new ExtractCache(cache);

    // Two-page stub: first call returns page 1 (hasNextPage=true, 2 PRs),
    // second call throws to simulate mid-extract failure.
    const p1 = [
      { number: 1, baseRefName: "main", mergedAt: "2026-02-20T00:00:00Z", updatedAt: "2026-02-20T00:00:00Z" },
      { number: 2, baseRefName: "main", mergedAt: "2026-02-15T00:00:00Z", updatedAt: "2026-02-15T00:00:00Z" },
    ];
    let call = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failingClient: any = {
      rest: {},
      baseUrl: "",
      async probeRemaining() {
        return null;
      },
      async graphql() {
        call += 1;
        if (call === 1) {
          return {
            repository: {
              defaultBranchRef: { name: "main" },
              pullRequests: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-after-page-1" },
                nodes: p1.map((n) => toNode(n)),
              },
            },
          };
        }
        throw new Error("network interrupted");
      },
    };

    await expect(
      extractAll(failingClient, { repos: ["o/r"] }, q, { cache: ec }),
    ).resolves.toMatchObject({ gaps: expect.arrayContaining([expect.any(Object)]) });

    // The checkpoint persists after the first successful page.
    const ckpt = ec.loadCheckpoint("o/r", q);
    expect(ckpt).not.toBeNull();
    expect(ckpt!.cursor).toBe("cursor-after-page-1");
    expect(ckpt!.pages).toBe(1);
    expect(ckpt!.partialPrs.map((p) => p.number)).toEqual([1, 2]);

    // Now resume successfully: second page returns nothing new, end.
    const p2 = [
      { number: 3, baseRefName: "main", mergedAt: "2026-02-10T00:00:00Z", updatedAt: "2026-02-10T00:00:00Z" },
    ];
    let resumeCall = 0;
    let seenCursor: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recoveringClient: any = {
      rest: {},
      baseUrl: "",
      async probeRemaining() {
        return null;
      },
      async graphql(_query: string, vars: Record<string, unknown>) {
        resumeCall += 1;
        seenCursor = vars.cursor as string | null;
        return {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: "end" },
              nodes: p2.map((n) => toNode(n)),
            },
          },
        };
      },
    };

    const res = await extractAll(recoveringClient, { repos: ["o/r"] }, q, { cache: ec });
    expect(res.prsByRepo.get("o/r")?.map((p) => p.number).sort()).toEqual([1, 2, 3]);
    // On resume, the first GraphQL call uses the persisted cursor — proving
    // we skipped page 1 rather than re-paginating from scratch.
    expect(seenCursor).toBe("cursor-after-page-1");
    expect(resumeCall).toBe(1);
    // After a successful extract, the checkpoint is cleared.
    expect(ec.loadCheckpoint("o/r", q)).toBeNull();
  });

  it("invokes onCheckpoint exactly once per page-boundary write", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    const ec = new ExtractCache(cache);
    const seen: Array<{
      repo: string;
      quarterLabel: string;
      pages: number;
      partialCount: number;
      cursor: string | null;
    }> = [];

    // Two-page success. Both page boundaries should fire onCheckpoint;
    // the SOC2 audit row in run.ts is keyed off this callback.
    let call = 0;
    const pages = [
      {
        cursor: "after-1",
        hasNext: true,
        nodes: [{ number: 1, baseRefName: "main", mergedAt: "2026-02-20T00:00:00Z", updatedAt: "2026-02-20T00:00:00Z" }],
      },
      {
        cursor: "after-2",
        hasNext: false,
        nodes: [{ number: 2, baseRefName: "main", mergedAt: "2026-02-15T00:00:00Z", updatedAt: "2026-02-15T00:00:00Z" }],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      rest: {},
      baseUrl: "",
      async probeRemaining() {
        return null;
      },
      async graphql() {
        const p = pages[call++]!;
        return {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: p.hasNext, endCursor: p.cursor },
              nodes: p.nodes.map((n) => toNode(n)),
            },
          },
        };
      },
    };

    await extractAll(client, { repos: ["o/r"] }, q, {
      cache: ec,
      onCheckpoint: (info) => seen.push(info),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      repo: "o/r",
      quarterLabel: "2026Q1",
      pages: 1,
      partialCount: 1,
      cursor: "after-1",
    });
    expect(seen[1]).toMatchObject({
      repo: "o/r",
      pages: 2,
      partialCount: 2,
      cursor: "after-2",
    });
  });
});

// Helper used by checkpoint-resume test: wraps a stub node into the full
// PullsNode shape the production extractor expects.
function toNode(n: {
  number: number;
  baseRefName: string;
  mergedAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    number: n.number,
    title: "feat: thing",
    body: "",
    url: `https://example/${n.number}`,
    state: "MERGED",
    mergedAt: n.mergedAt,
    updatedAt: n.updatedAt,
    baseRefName: n.baseRefName,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    author: { login: "alice" },
    labels: { nodes: [] },
    milestone: null,
    comments: { totalCount: 0 },
    mergeCommit: { message: null },
    reviews: { nodes: [] },
    reviewRequests: { nodes: [] },
    closingIssuesReferences: { nodes: [] },
  };
}

describe("extractAll — node payload mapping (nodeToRaw)", () => {
  it("maps milestone, reviews, review requests, and linked issues from a fully-populated GraphQL node", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const richClient: any = {
      rest: {},
      baseUrl: "",
      async probeRemaining() {
        return 4999;
      },
      async graphql() {
        return {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: "x" },
              nodes: [
                {
                  number: 42,
                  title: "feat: add widget",
                  body: "Fixes #99\n\nWith a co-author.",
                  url: "https://example/42",
                  state: "MERGED",
                  mergedAt: "2026-02-15T12:00:00Z",
                  updatedAt: "2026-02-15T12:00:00Z",
                  baseRefName: "main",
                  additions: 100,
                  deletions: 20,
                  changedFiles: 5,
                  author: { login: "alice" },
                  labels: { nodes: [{ name: "feature" }, { name: "p1" }] },
                  milestone: { title: "Q1 launch" },
                  comments: { totalCount: 7 },
                  mergeCommit: {
                    message:
                      "feat: add widget\n\nCo-authored-by: Bob <7+bob@users.noreply.github.com>",
                  },
                  reviews: {
                    nodes: [
                      { author: { login: "carol" }, state: "APPROVED", comments: { totalCount: 2 } },
                      { author: null, state: "DISMISSED", comments: { totalCount: 0 } },
                    ],
                  },
                  reviewRequests: {
                    nodes: [
                      { requestedReviewer: { login: "dave" } },
                      { requestedReviewer: { name: "platform-team" } },
                      { requestedReviewer: null },
                    ],
                  },
                  closingIssuesReferences: {
                    nodes: [
                      {
                        number: 99,
                        title: "Widget request",
                        url: "https://example/99",
                        closedAt: "2026-02-15T12:30:00Z",
                        repository: { nameWithOwner: "o/r" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        };
      },
    };
    const res = await extractAll(richClient, { repos: ["o/r"] }, q);
    const pr = res.prsByRepo.get("o/r")![0]!;

    expect(pr.author).toBe("alice");
    expect(pr.coAuthors).toEqual(["bob"]);
    expect(pr.milestone).toEqual({ title: "Q1 launch" });
    expect(pr.labels.map((l) => l.name)).toEqual(["feature", "p1"]);
    // Reviews: only entries with an author login survive the filter.
    expect(pr.reviews).toEqual([
      { user: "carol", state: "APPROVED", inlineCommentCount: 2 },
    ]);
    // Review requests: user logins + team names; null reviewers dropped.
    expect(pr.reviewRequests).toEqual(["dave", "platform-team"]);
    expect(pr.linkedIssues).toEqual([
      {
        repo: "o/r",
        number: 99,
        title: "Widget request",
        url: "https://example/99",
        closedAt: "2026-02-15T12:30:00Z",
      },
    ]);
    expect(pr.comments).toBe(7);
    expect(pr.changedFiles).toBe(5);
    expect(pr.additions).toBe(100);
    expect(pr.deletions).toBe(20);
  });

  it("handles a node with a null author by stamping it as 'ghost'", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      rest: {},
      baseUrl: "",
      async probeRemaining() {
        return null;
      },
      async graphql() {
        return {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: "x" },
              nodes: [
                {
                  number: 1,
                  title: "fix: orphaned",
                  body: null,
                  url: "https://example/1",
                  state: "MERGED",
                  mergedAt: "2026-02-01T00:00:00Z",
                  updatedAt: "2026-02-01T00:00:00Z",
                  baseRefName: "main",
                  additions: 0,
                  deletions: 0,
                  changedFiles: 0,
                  author: null,
                  labels: { nodes: [] },
                  milestone: null,
                  comments: { totalCount: 0 },
                  mergeCommit: null,
                  reviews: { nodes: [] },
                  reviewRequests: { nodes: [] },
                  closingIssuesReferences: { nodes: [] },
                },
              ],
            },
          },
        };
      },
    };
    const res = await extractAll(client, { repos: ["o/r"] }, q);
    const pr = res.prsByRepo.get("o/r")![0]!;
    expect(pr.author).toBe("ghost");
    expect(pr.body).toBe("");
    expect(pr.milestone).toBeNull();
  });

  it("stops paginating at the 40-page safety cap", async () => {
    const q = quarterLabelToRange("2026Q1", "UTC");
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      rest: {},
      baseUrl: "",
      async probeRemaining() {
        return null;
      },
      async graphql() {
        calls += 1;
        // Always return one in-window node + claim hasNextPage=true.
        return {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: true, endCursor: `p${calls}` },
              nodes: [toNodePayload(calls, "2026-02-15T00:00:00Z")],
            },
          },
        };
      },
    };
    const logs: string[] = [];
    await extractAll(client, { repos: ["o/r"] }, q, { log: (m) => logs.push(m) });
    // Cap is 40 pages; we exit cleanly with the cap warning logged once.
    expect(calls).toBeLessThanOrEqual(41);
    expect(logs.some((l) => /40 pages \(safety cap\)/.test(l))).toBe(true);
  });
});

function toNodePayload(num: number, ts: string): Record<string, unknown> {
  return {
    number: num,
    title: "feat: x",
    body: "",
    url: `https://example/${num}`,
    state: "MERGED",
    mergedAt: ts,
    updatedAt: ts,
    baseRefName: "main",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    author: { login: "alice" },
    labels: { nodes: [] },
    milestone: null,
    comments: { totalCount: 0 },
    mergeCommit: { message: null },
    reviews: { nodes: [] },
    reviewRequests: { nodes: [] },
    closingIssuesReferences: { nodes: [] },
  };
}

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
