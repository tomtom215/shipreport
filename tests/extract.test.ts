import { describe, expect, it } from "vitest";
import { extractAll } from "../src/extract.js";
import type { GithubClient } from "../src/github.js";
import { quarterLabelToRange } from "../src/tz.js";

interface StubNode {
  number: number;
  baseRefName: string;
  mergedAt: string;
  title?: string;
  body?: string;
  author?: string;
  coAuthorsCommitMessage?: string;
}

function stubClient(nodes: StubNode[], defaultBranch = "main"): GithubClient {
  const gql = async (): Promise<unknown> => ({
    repository: {
      defaultBranchRef: { name: defaultBranch },
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: "x" },
        nodes: nodes.map((n) => ({
          number: n.number,
          title: n.title ?? "feat: thing",
          body: n.body ?? "",
          url: `https://example/${n.number}`,
          state: "MERGED",
          mergedAt: n.mergedAt,
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
  });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphql: gql as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rest: {} as any,
    baseUrl: "",
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
