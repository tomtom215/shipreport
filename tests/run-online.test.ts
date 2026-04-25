/**
 * Non-dry-run runTeam tests using nock to intercept GraphQL.
 *
 * Drives the full run.ts pipeline end-to-end (including the github.ts
 * client and the rate-limit guard wiring). This is the only way to
 * cover the non-dry-run branches of run.ts:
 *
 *   * `onDegrade` callback that emits the `rate_limit_degraded` audit row
 *     (run.ts ~95-98)
 *   * the `droppedNonDefaultBranch > 0` info log (run.ts ~134)
 *   * the `gaps.map(...)` projection on the return shape (run.ts ~253)
 *
 * Tests that inject a fake `tokenSource` to avoid `tokenSourceFromConfig`
 * (which reads env / files) — but the fake matches the same TokenSource
 * interface so run.ts and github.ts treat it identically to a real PAT.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nock from "nock";
import { normalize } from "../src/config.js";
import { runTeam, openState, auditLogFor } from "../src/run.js";

beforeEach(() => {
  nock.disableNetConnect();
  // Force a known token in the env so tokenSourceFromConfig doesn't throw.
  process.env.SHIPREPORT_GITHUB_TOKEN = "test-token";
});
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.SHIPREPORT_GITHUB_TOKEN;
});

const PR_NODE = (over: Record<string, unknown>): Record<string, unknown> => ({
  number: 1,
  title: "feat: x",
  body: "",
  url: "https://example/1",
  state: "MERGED",
  mergedAt: "2026-04-12T12:00:00Z",
  updatedAt: "2026-04-12T12:00:00Z",
  baseRefName: "main",
  additions: 10,
  deletions: 1,
  changedFiles: 1,
  author: { login: "alice" },
  labels: { nodes: [] },
  milestone: null,
  comments: { totalCount: 0 },
  mergeCommit: { message: null },
  reviews: { nodes: [] },
  reviewRequests: { nodes: [] },
  closingIssuesReferences: { nodes: [] },
  ...over,
});

describe("runTeam — online paths via nock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-run-online-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits rate_limit_degraded audit row + dropped-non-default log when GraphQL returns low remaining + a non-default-branch PR", async () => {
    // GraphQL query mock: low rate limit + 1 in-window PR on `main` + 1 PR on a release branch.
    nock("https://api.github.com")
      .post("/graphql")
      .reply(200, {
        data: {
          rateLimit: { remaining: 50 }, // below default threshold of 100 → degrade
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: "x" },
              nodes: [
                PR_NODE({ number: 1, baseRefName: "main", mergedAt: "2026-04-12T12:00:00Z", updatedAt: "2026-04-12T12:00:00Z" }),
                PR_NODE({ number: 2, baseRefName: "release/1.0", mergedAt: "2026-04-13T12:00:00Z", updatedAt: "2026-04-13T12:00:00Z" }),
              ],
            },
          },
        },
      });
    // The end-of-run probeRemaining() call.
    nock("https://api.github.com")
      .post("/graphql")
      .reply(200, { data: { rateLimit: { remaining: 50 } } });

    const cfg = normalize({
      github: { tokenEnv: "SHIPREPORT_GITHUB_TOKEN" },
      org: "o",
      teams: [{ name: "t", manager: "alice", members: ["alice"], repos: ["o/r"] }],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: true, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
      extract: { concurrency: 1, rateLimitThreshold: 100 },
    });

    const state = (await openState(cfg))!;
    const audit = auditLogFor(state);
    const logs: string[] = [];
    const result = await runTeam({
      cfg,
      team: cfg.teams[0]!,
      log: (m) => logs.push(m),
      audit,
      triggeredBy: "manual",
    });
    state.close();

    // The run completed; the per-dev report was written.
    expect(result.written.some((p) => /alice-2026Q2\.md$/.test(p))).toBe(true);
    // gaps was empty (no failed repos), so the gaps.map projection ran
    // over an empty array — but the ARRAY ITSELF is the projection, and
    // it must be a real array with the documented shape:
    expect(Array.isArray(result.gaps)).toBe(true);
    // dropped-non-default log fired.
    expect(logs.some((l) => /dropped 1 merged PR/.test(l))).toBe(true);

    // rate_limit_degraded audit row written.
    const reopened = (await openState(cfg))!;
    const events = auditLogFor(reopened).tail(100).map((r) => r.event);
    reopened.close();
    expect(events).toContain("rate_limit_degraded");
    expect(events).toContain("token_resolved");
  });

  it("reports a per-repo data gap (with reason) when a repo's GraphQL fails", async () => {
    // First repo's GraphQL call fails with 500; runTeam records it as a
    // gap rather than throwing. Second repo's call succeeds with no PRs.
    nock("https://api.github.com")
      .post("/graphql")
      .reply(500, { message: "internal" })
      .post("/graphql")
      .reply(200, {
        data: {
          rateLimit: { remaining: 4999 },
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: "x" },
              nodes: [],
            },
          },
        },
      })
      // probeRemaining at the end
      .post("/graphql")
      .reply(200, { data: { rateLimit: { remaining: 4900 } } });

    const cfg = normalize({
      github: { tokenEnv: "SHIPREPORT_GITHUB_TOKEN" },
      org: "o",
      teams: [
        {
          name: "t",
          manager: "alice",
          members: ["alice"],
          repos: ["o/broken", "o/empty"],
        },
      ],
      defaults: {
        quarter: "2026Q2",
        timezone: "UTC",
        output: { dir: path.join(dir, "out"), formats: ["md"] },
      },
      audit: { enabled: false, path: path.join(dir, "state.sqlite") },
      cache: { path: path.join(dir, "cache.sqlite"), ttlDays: 7 },
      extract: { concurrency: 1, rateLimitThreshold: 100 },
    });

    const result = await runTeam({
      cfg,
      team: cfg.teams[0]!,
      log: () => {},
      triggeredBy: "manual",
    });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.repo).toBe("o/broken");
    expect(result.gaps[0]!.reason).toMatch(/.+/); // any non-empty reason string
  });
});
