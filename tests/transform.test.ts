import { describe, expect, it } from "vitest";
import { aggregateDev, buildTeamQuarter, toPRSummary } from "../src/transform.js";
import type { Config } from "../src/config.js";
import type { RawPR } from "../src/types.js";

const cfg: Config = {
  github: {
    baseUrl: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    tokenEnv: "SHIPREPORT_GITHUB_TOKEN",
  },
  org: "acme",
  repos: ["acme/svc-a", "acme/svc-b"],
  quarter: "2026Q1",
  timezone: "UTC",
  team: { manager: "jdoe", members: ["alice", "bob"] },
  classification: {
    bugfixLabels: ["bug"],
    featureLabels: ["feature"],
    infraLabels: ["infra"],
    docsLabels: ["docs"],
  },
  output: {
    dir: "./out",
    formats: ["md"],
    perDev: true,
    teamSummary: true,
    managerRollup: true,
  },
  cache: { path: "/tmp/cache.db", ttlDays: 7 },
};

function pr(over: Partial<RawPR>): RawPR {
  return {
    repo: "acme/svc-a",
    number: 1,
    url: "https://example/1",
    title: "x",
    body: "",
    state: "MERGED",
    mergedAt: "2026-02-01T00:00:00Z",
    author: "alice",
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

describe("toPRSummary", () => {
  it("deduplicates reviewers and drops self-reviews", () => {
    const s = toPRSummary(
      pr({
        reviews: [
          { user: "alice", state: "APPROVED" }, // self, must be excluded
          { user: "bob", state: "APPROVED" },
          { user: "bob", state: "COMMENTED" }, // dup
          { user: "carol", state: "CHANGES_REQUESTED" },
        ],
      }),
      cfg.classification,
    );
    expect(s.reviewers.sort()).toEqual(["bob", "carol"]);
  });

  it("formats linked issues as repo#number", () => {
    const s = toPRSummary(
      pr({
        linkedIssues: [{ repo: "acme/svc-a", number: 42, title: "t", url: "u", closedAt: null }],
      }),
      cfg.classification,
    );
    expect(s.linkedIssues).toEqual(["acme/svc-a#42"]);
  });
});

describe("aggregateDev", () => {
  it("only counts PRs authored by the dev", () => {
    const prs = [pr({ author: "alice" }), pr({ author: "bob", number: 2 })];
    const d = aggregateDev("alice", prs, cfg);
    expect(d.prsMerged).toBe(1);
  });

  it("counts reviews given on others' PRs", () => {
    const prs = [
      pr({
        author: "bob",
        number: 10,
        reviews: [{ user: "alice", state: "APPROVED" }],
      }),
      pr({
        author: "carol",
        number: 11,
        reviews: [{ user: "alice", state: "COMMENTED" }],
      }),
      pr({
        author: "alice",
        number: 12,
        reviews: [{ user: "bob", state: "APPROVED" }],
      }),
    ];
    const d = aggregateDev("alice", prs, cfg);
    expect(d.reviewsGiven).toBe(2);
  });

  it("sums filesTouched and crossRepoCollaboration", () => {
    const prs = [
      pr({ author: "alice", repo: "acme/svc-a", changedFiles: 3 }),
      pr({ author: "alice", repo: "acme/svc-b", number: 2, changedFiles: 5 }),
    ];
    const d = aggregateDev("alice", prs, cfg);
    expect(d.filesTouched).toBe(8);
    expect(d.crossRepoCollaboration).toBe(2);
  });

  it("selects top PRs by score (reviews*3 + comments + issues*2), deterministic ties", () => {
    const prs = [
      pr({
        author: "alice",
        number: 1,
        title: "low",
        reviews: [{ user: "bob", state: "APPROVED" }],
      }),
      pr({
        author: "alice",
        number: 2,
        title: "high",
        reviews: [
          { user: "bob", state: "APPROVED" },
          { user: "carol", state: "APPROVED" },
          { user: "dave", state: "COMMENTED" },
        ],
        comments: 5,
        linkedIssues: [
          { repo: "acme/svc-a", number: 10, title: "", url: "", closedAt: null },
        ],
      }),
      pr({ author: "alice", number: 3, title: "mid", comments: 3 }),
    ];
    const d = aggregateDev("alice", prs, cfg);
    // PR 2 wins (score 16). PRs 1 and 3 tie at score 3, broken by (repo, number):
    // same repo, so ascending PR number → [2, 1, 3].
    expect(d.topPRs.map((p) => p.number)).toEqual([2, 1, 3]);
  });

  it("dedupes linked issues across multiple PRs", () => {
    const linked = { repo: "acme/svc-a", number: 99, title: "t", url: "u", closedAt: null };
    const prs = [
      pr({ author: "alice", number: 1, linkedIssues: [linked] }),
      pr({ author: "alice", number: 2, linkedIssues: [linked] }),
    ];
    const d = aggregateDev("alice", prs, cfg);
    expect(d.linkedIssuesClosed).toHaveLength(1);
  });

  it("collects shippedMilestones, sorted", () => {
    const prs = [
      pr({ author: "alice", number: 1, milestone: { title: "Launch B" } }),
      pr({ author: "alice", number: 2, milestone: { title: "Launch A" } }),
      pr({ author: "alice", number: 3, milestone: { title: "Launch A" } }),
    ];
    const d = aggregateDev("alice", prs, cfg);
    expect(d.shippedMilestones).toEqual(["Launch A", "Launch B"]);
  });

  it("zero PRs → empty buckets, not NaN", () => {
    const d = aggregateDev("ghost", [], cfg);
    expect(d.prsMerged).toBe(0);
    expect(d.filesTouched).toBe(0);
    expect(d.crossRepoCollaboration).toBe(0);
    expect(d.topPRs).toEqual([]);
  });
});

describe("buildTeamQuarter", () => {
  it("aggregates totals across team members", () => {
    const prs = [
      pr({ author: "alice", repo: "acme/svc-a", number: 1 }),
      pr({
        author: "bob",
        repo: "acme/svc-b",
        number: 2,
        reviews: [{ user: "alice", state: "APPROVED" }],
      }),
    ];
    const team = buildTeamQuarter(
      cfg,
      { label: "2026Q1", from: "2026-01-01", to: "2026-03-31" },
      new Map([
        ["acme/svc-a", prs.filter((p) => p.repo === "acme/svc-a")],
        ["acme/svc-b", prs.filter((p) => p.repo === "acme/svc-b")],
      ]),
      [],
    );
    expect(team.totals.prsMerged).toBe(2);
    expect(team.totals.reviewsGiven).toBe(1); // alice reviewed bob's PR
    expect(team.members.map((m) => m.login)).toEqual(["alice", "bob"]);
  });

  it("passes data gaps through", () => {
    const team = buildTeamQuarter(
      cfg,
      { label: "2026Q1", from: "2026-01-01", to: "2026-03-31" },
      new Map(),
      [{ repo: "acme/svc-a", reason: "404", at: "2026-04-01T00:00:00Z" }],
    );
    expect(team.dataGaps).toHaveLength(1);
  });
});
