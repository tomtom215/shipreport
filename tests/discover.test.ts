import { describe, expect, it } from "vitest";
import { discoverMembers, isBot, DEFAULT_DISCOVER } from "../src/discover.js";
import type { RawPR } from "../src/types.js";

function pr(author: string, over: Partial<RawPR> = {}): RawPR {
  return {
    repo: "o/r",
    number: Math.floor(Math.random() * 1_000_000),
    url: "u",
    title: "t",
    body: "",
    state: "MERGED",
    mergedAt: "2026-02-01T00:00:00Z",
    author,
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

describe("isBot", () => {
  it("detects [bot] suffix", () => {
    expect(isBot("dependabot[bot]")).toBe(true);
    expect(isBot("renovate[bot]")).toBe(true);
  });
  it("detects -bot / -robot suffixes", () => {
    expect(isBot("release-bot")).toBe(true);
    expect(isBot("deploy-robot")).toBe(true);
  });
  it("detects built-in bot logins case-insensitively", () => {
    expect(isBot("dependabot")).toBe(true);
    expect(isBot("DEPENDABOT")).toBe(true);
    expect(isBot("github-actions")).toBe(true);
    expect(isBot("pre-commit-ci")).toBe(true);
  });
  it("does not flag ordinary logins", () => {
    expect(isBot("asmith")).toBe(false);
    expect(isBot("robotomtom")).toBe(false);
    expect(isBot("carbot-human")).toBe(false);
  });
});

describe("discoverMembers", () => {
  it("ranks by merged-PR count, descending", () => {
    const prs = [
      pr("alice"),
      pr("alice"),
      pr("alice"),
      pr("bob"),
      pr("bob"),
      pr("carol"),
    ];
    const r = discoverMembers(prs);
    expect(r.members).toEqual(["alice", "bob", "carol"]);
  });

  it("breaks ties alphabetically (deterministic)", () => {
    const prs = [pr("charlie"), pr("alice"), pr("bob")];
    const r = discoverMembers(prs);
    expect(r.members).toEqual(["alice", "bob", "charlie"]);
  });

  it("respects the limit", () => {
    const authors = ["a", "b", "c", "d", "e", "f"];
    const prs = authors.flatMap((a) => [pr(a), pr(a)]);
    const r = discoverMembers(prs, { ...DEFAULT_DISCOVER, limit: 3 });
    expect(r.members).toHaveLength(3);
  });

  it("skips bots by default and tracks them in skippedBots", () => {
    const prs = [
      pr("dependabot[bot]"),
      pr("alice"),
      pr("renovate"),
      pr("bob"),
    ];
    const r = discoverMembers(prs);
    expect(r.members.sort()).toEqual(["alice", "bob"]);
    expect(r.skippedBots).toContain("dependabot[bot]");
    expect(r.skippedBots).toContain("renovate");
  });

  it("keeps bots when excludeBots=false", () => {
    const prs = [pr("dependabot[bot]"), pr("alice")];
    const r = discoverMembers(prs, { ...DEFAULT_DISCOVER, excludeBots: false });
    expect(r.members).toContain("dependabot[bot]");
  });

  it("honors excludeLogins (case-insensitive)", () => {
    const prs = [pr("Alice"), pr("bob")];
    const r = discoverMembers(prs, { ...DEFAULT_DISCOVER, excludeLogins: ["alice"] });
    expect(r.members).toEqual(["bob"]);
  });

  it("ignores un-merged PRs", () => {
    const prs = [
      pr("alice", { mergedAt: null, state: "OPEN" }),
      pr("bob"),
    ];
    const r = discoverMembers(prs);
    expect(r.members).toEqual(["bob"]);
  });

  it("ignores ghost author", () => {
    const prs = [pr("ghost"), pr("alice")];
    const r = discoverMembers(prs);
    expect(r.members).toEqual(["alice"]);
  });

  it("handles an empty PR list", () => {
    const r = discoverMembers([]);
    expect(r.members).toEqual([]);
    expect(r.considered).toBe(0);
  });

  it("rankings include everyone considered, not just top N", () => {
    const prs = [
      pr("alice"),
      pr("alice"),
      pr("bob"),
      pr("carol"),
    ];
    const r = discoverMembers(prs, { ...DEFAULT_DISCOVER, limit: 2 });
    expect(r.members).toEqual(["alice", "bob"]);
    expect(r.rankings.map((x) => x.login)).toEqual(["alice", "bob", "carol"]);
  });
});
