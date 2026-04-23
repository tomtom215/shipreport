import { describe, expect, it } from "vitest";
import {
  aggregateDev,
  buildTeamQuarter,
  toPRSummary,
  type TransformOptions,
} from "../src/transform.js";
import type { ClassificationConfig } from "../src/classify.js";
import type { RawPR } from "../src/types.js";

const classification: ClassificationConfig = {
  bugfixLabels: ["bug"],
  featureLabels: ["feature"],
  infraLabels: ["infra"],
  docsLabels: ["docs"],
};

const opts: TransformOptions = { classification, coAuthorCredit: "full" };

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

describe("toPRSummary", () => {
  it("deduplicates reviewers and drops self-reviews", () => {
    const s = toPRSummary(
      pr({
        reviews: [
          { user: "alice", state: "APPROVED" },
          { user: "bob", state: "APPROVED" },
          { user: "bob", state: "COMMENTED" },
          { user: "carol", state: "CHANGES_REQUESTED" },
        ],
      }),
      classification,
    );
    expect(s.reviewers.sort()).toEqual(["bob", "carol"]);
  });

  it("formats linked issues as repo#number", () => {
    const s = toPRSummary(
      pr({
        linkedIssues: [{ repo: "acme/svc-a", number: 42, title: "t", url: "u", closedAt: null }],
      }),
      classification,
    );
    expect(s.linkedIssues).toEqual(["acme/svc-a#42"]);
  });
});

describe("aggregateDev", () => {
  it("only counts PRs authored by the dev", () => {
    const prs = [pr({ author: "alice" }), pr({ author: "bob", number: 2 })];
    const d = aggregateDev("alice", prs, opts);
    expect(d.prsMerged).toBe(1);
  });

  it("reviewsGiven = substantive only; reviewEventsGiven = raw count", () => {
    const prs = [
      pr({
        author: "bob",
        number: 10,
        reviews: [{ user: "alice", state: "APPROVED" }],
      }),
      pr({
        author: "carol",
        number: 11,
        // COMMENTED with no inline replies is NOT substantive.
        reviews: [{ user: "alice", state: "COMMENTED", inlineCommentCount: 0 }],
      }),
      pr({
        author: "dave",
        number: 13,
        // COMMENTED with inline reply IS substantive.
        reviews: [{ user: "alice", state: "COMMENTED", inlineCommentCount: 3 }],
      }),
      pr({
        author: "alice",
        number: 12,
        reviews: [{ user: "bob", state: "APPROVED" }],
      }),
    ];
    const d = aggregateDev("alice", prs, opts);
    expect(d.reviewsGiven).toBe(2);
    expect(d.reviewEventsGiven).toBe(3);
  });

  it("sums filesTouched and crossRepoCollaboration", () => {
    const prs = [
      pr({ author: "alice", repo: "acme/svc-a", changedFiles: 3 }),
      pr({ author: "alice", repo: "acme/svc-b", number: 2, changedFiles: 5 }),
    ];
    const d = aggregateDev("alice", prs, opts);
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
    const d = aggregateDev("alice", prs, opts);
    expect(d.topPRs.map((p) => p.number)).toEqual([2, 1, 3]);
  });

  it("dedupes linked issues across multiple PRs", () => {
    const linked = { repo: "acme/svc-a", number: 99, title: "t", url: "u", closedAt: null };
    const prs = [
      pr({ author: "alice", number: 1, linkedIssues: [linked] }),
      pr({ author: "alice", number: 2, linkedIssues: [linked] }),
    ];
    const d = aggregateDev("alice", prs, opts);
    expect(d.linkedIssuesClosed).toHaveLength(1);
  });

  it("collects shippedMilestones, sorted", () => {
    const prs = [
      pr({ author: "alice", number: 1, milestone: { title: "Launch B" } }),
      pr({ author: "alice", number: 2, milestone: { title: "Launch A" } }),
      pr({ author: "alice", number: 3, milestone: { title: "Launch A" } }),
    ];
    const d = aggregateDev("alice", prs, opts);
    expect(d.shippedMilestones).toEqual(["Launch A", "Launch B"]);
  });

  it("zero PRs → empty buckets, not NaN", () => {
    const d = aggregateDev("ghost", [], opts);
    expect(d.prsMerged).toBe(0);
    expect(d.filesTouched).toBe(0);
    expect(d.crossRepoCollaboration).toBe(0);
    expect(d.topPRs).toEqual([]);
  });
});

describe("aggregateDev — co-authors", () => {
  it("default 'full' credit: author and each co-author get +1 prsMerged, +files filesTouched", () => {
    const prs = [
      pr({ author: "alice", coAuthors: ["bob"], changedFiles: 10 }),
    ];
    const a = aggregateDev("alice", prs, opts);
    const b = aggregateDev("bob", prs, opts);
    expect(a.prsMerged).toBe(1);
    expect(b.prsMerged).toBe(1);
    expect(a.filesTouched).toBe(10);
    expect(b.filesTouched).toBe(10);
  });

  it("'split' credit: each contributor gets 1/N credit on prsMerged and filesTouched", () => {
    const prs = [
      pr({ author: "alice", coAuthors: ["bob"], changedFiles: 10 }),
    ];
    const splitOpts: TransformOptions = { classification, coAuthorCredit: "split" };
    const a = aggregateDev("alice", prs, splitOpts);
    const b = aggregateDev("bob", prs, splitOpts);
    expect(a.prsMerged).toBeCloseTo(0.5);
    expect(b.prsMerged).toBeCloseTo(0.5);
    expect(a.filesTouched).toBe(5);
    expect(b.filesTouched).toBe(5);
  });

  it("co-author listed twice (author + Co-authored-by) is not double-counted", () => {
    const prs = [pr({ author: "alice", coAuthors: ["alice"], changedFiles: 4 })];
    const a = aggregateDev("alice", prs, opts);
    expect(a.prsMerged).toBe(1);
    expect(a.filesTouched).toBe(4);
  });
});

describe("aggregateDev — reverts", () => {
  it("marks a revert PR with isRevert + surfaces count under revertsAuthored", () => {
    const prs = [
      pr({
        author: "alice",
        number: 500,
        title: 'Revert "feat: thing" (#412)',
        labels: [{ name: "bug" }],
      }),
    ];
    const a = aggregateDev("alice", prs, opts);
    expect(a.revertsAuthored).toBe(1);
    expect(a.topPRs[0]!.isRevert).toBe(true);
    expect(a.topPRs[0]!.revert).toEqual({ repo: "acme/svc-a", number: 412 });
  });

  it("subtracts the reverted PR from the original author when both are in window", () => {
    const original = pr({
      author: "bob",
      number: 412,
      title: "feat: thing",
      changedFiles: 20,
    });
    const revert = pr({
      author: "alice",
      number: 500,
      title: 'Revert "feat: thing" (#412)',
      labels: [{ name: "bug" }],
    });
    const bob = aggregateDev("bob", [original, revert], opts);
    expect(bob.prsMerged).toBe(0);
    expect(bob.filesTouched).toBe(0);
    expect(bob.revertsReceived).toBe(1);
  });

  it("does not affect bob when the revert is outside the prs set", () => {
    const original = pr({ author: "bob", number: 412, changedFiles: 20 });
    const bob = aggregateDev("bob", [original], opts);
    expect(bob.prsMerged).toBe(1);
    expect(bob.revertsReceived).toBe(0);
  });
});

describe("aggregateDev — body-linked issues fallback", () => {
  it("picks up 'Fixes #N' from the body when GraphQL returned nothing", () => {
    const prs = [
      pr({ author: "alice", body: "Some description.\n\nFixes #123", linkedIssues: [] }),
    ];
    const a = aggregateDev("alice", prs, opts);
    expect(a.linkedIssuesClosed.map((i) => `${i.repo}#${i.number}`)).toContain(
      "acme/svc-a#123",
    );
  });

  it("cross-repo form 'Closes other/repo#99' resolves to the referenced repo", () => {
    const prs = [
      pr({ author: "alice", body: "Closes other/repo#99", linkedIssues: [] }),
    ];
    const a = aggregateDev("alice", prs, opts);
    expect(a.linkedIssuesClosed[0]!.repo).toBe("other/repo");
    expect(a.linkedIssuesClosed[0]!.number).toBe(99);
  });

  it("GraphQL ref wins: body 'Fixes #1' duplicating a GQL ref produces one entry", () => {
    const prs = [
      pr({
        author: "alice",
        body: "Fixes #1",
        linkedIssues: [
          { repo: "acme/svc-a", number: 1, title: "Real", url: "u", closedAt: null },
        ],
      }),
    ];
    const a = aggregateDev("alice", prs, opts);
    expect(a.linkedIssuesClosed).toHaveLength(1);
    expect(a.linkedIssuesClosed[0]!.title).toBe("Real");
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
      {
        manager: "jdoe",
        members: ["alice", "bob"],
        repos: ["acme/svc-a", "acme/svc-b"],
        classification,
        coAuthorCredit: "full",
      },
      { label: "2026Q1", from: "2026-01-01", to: "2026-03-31" },
      new Map([
        ["acme/svc-a", prs.filter((p) => p.repo === "acme/svc-a")],
        ["acme/svc-b", prs.filter((p) => p.repo === "acme/svc-b")],
      ]),
      [],
    );
    expect(team.totals.prsMerged).toBe(2);
    expect(team.totals.reviewsGiven).toBe(1);
    expect(team.members.map((m) => m.login)).toEqual(["alice", "bob"]);
  });

  it("passes data gaps through", () => {
    const team = buildTeamQuarter(
      {
        manager: "jdoe",
        members: ["alice"],
        repos: ["acme/svc-a"],
        classification,
        coAuthorCredit: "full",
      },
      { label: "2026Q1", from: "2026-01-01", to: "2026-03-31" },
      new Map(),
      [{ repo: "acme/svc-a", reason: "404", at: "2026-04-01T00:00:00Z" }],
    );
    expect(team.dataGaps).toHaveLength(1);
  });
});
