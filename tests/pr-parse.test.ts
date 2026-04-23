import { describe, expect, it } from "vitest";
import {
  coAuthorLoginFromEmail,
  detectRevert,
  mergeLinkedIssues,
  parseBodyIssueRefs,
  parseCoAuthors,
} from "../src/pr-parse.js";

describe("parseBodyIssueRefs", () => {
  it("matches every verb variant, case-insensitive", () => {
    const body = [
      "Fix #1",
      "FIXES #2",
      "fixed #3",
      "Close #4",
      "Closes #5",
      "CLOSED #6",
      "Resolve #7",
      "Resolves #8",
      "Resolved #9",
    ].join("\n");
    const refs = parseBodyIssueRefs(body);
    expect(refs.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(refs.every((r) => r.repo === null)).toBe(true);
  });

  it("distinguishes same-repo (#N) from cross-repo (owner/repo#N)", () => {
    const refs = parseBodyIssueRefs(
      "Fixes #42 and Closes octo/cat#7 and fixes foo-bar/baz.qux#99",
    );
    expect(refs).toEqual([
      { repo: null, number: 42 },
      { repo: "octo/cat", number: 7 },
      { repo: "foo-bar/baz.qux", number: 99 },
    ]);
  });

  it("dedupes repeated references in the same body", () => {
    const refs = parseBodyIssueRefs("Fixes #1. Also fixes #1 and resolves octo/cat#2. closes octo/cat#2.");
    expect(refs).toEqual([
      { repo: null, number: 1 },
      { repo: "octo/cat", number: 2 },
    ]);
  });

  it("ignores prose like 'fixing the #1 issue' that isn't a close verb form", () => {
    // "fixing" isn't in the close-verb list; "the #1 issue" has no close verb.
    const refs = parseBodyIssueRefs("While fixing the #1 issue we noticed ...");
    expect(refs).toEqual([]);
  });

  it("empty body returns []", () => {
    expect(parseBodyIssueRefs("")).toEqual([]);
  });
});

describe("mergeLinkedIssues", () => {
  it("prefers the GraphQL ref over a body ref for the same issue (keeps title/url)", () => {
    const fromGql = [
      { repo: "o/r", number: 1, title: "Real", url: "https://gh/1", closedAt: "2026-02-01" },
    ];
    const fromBody = [{ repo: null, number: 1 }];
    const merged = mergeLinkedIssues(fromGql, fromBody, "o/r");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Real");
  });

  it("adds a body-only ref with placeholder title/url", () => {
    const merged = mergeLinkedIssues([], [{ repo: null, number: 5 }], "o/r");
    expect(merged).toEqual([
      { repo: "o/r", number: 5, title: "", url: "", closedAt: null },
    ]);
  });

  it("resolves cross-repo body refs", () => {
    const merged = mergeLinkedIssues([], [{ repo: "other/place", number: 9 }], "o/r");
    expect(merged[0]!.repo).toBe("other/place");
  });
});

describe("parseCoAuthors", () => {
  it("extracts trailers with display name + email", () => {
    const msg = [
      "Commit subject",
      "",
      "Body paragraph.",
      "",
      "Co-authored-by: Alice Smith <alice@example.com>",
      "Co-authored-by: Bob <bob@example.org>",
    ].join("\n");
    const cs = parseCoAuthors(msg);
    expect(cs).toEqual([
      { name: "Alice Smith", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.org" },
    ]);
  });

  it("dedupes by email when the same co-author appears twice", () => {
    const msg = "Co-authored-by: A <a@x.io>\nCo-authored-by: A <a@x.io>";
    expect(parseCoAuthors(msg)).toHaveLength(1);
  });

  it("handles empty / null", () => {
    expect(parseCoAuthors(null)).toEqual([]);
    expect(parseCoAuthors("")).toEqual([]);
  });
});

describe("coAuthorLoginFromEmail", () => {
  it("extracts a login from GitHub noreply emails", () => {
    expect(coAuthorLoginFromEmail("1234567+octocat@users.noreply.github.com")).toBe("octocat");
    expect(coAuthorLoginFromEmail("octocat@users.noreply.github.com")).toBe("octocat");
  });
  it("returns null for non-noreply emails", () => {
    expect(coAuthorLoginFromEmail("alice@example.com")).toBeNull();
  });
});

describe("detectRevert", () => {
  it("matches GitHub's default revert title and extracts the PR number", () => {
    const info = detectRevert('Revert "feat: thing" (#412)', "");
    expect(info).toEqual({ revertedNumber: 412 });
  });

  it("matches conventional-commit 'revert:' prefix", () => {
    const info = detectRevert("revert: Apple Pay integration", "Reverts #412");
    expect(info).toEqual({ revertedNumber: 412 });
  });

  it("matches 'Reverts #N' in body even when title is unrelated", () => {
    const info = detectRevert("Revert unrelated change", "Reverts #99 because of regression.");
    expect(info).toEqual({ revertedNumber: 99 });
  });

  it("returns null for non-reverts", () => {
    expect(detectRevert("feat: add widget", "adds a widget")).toBeNull();
    expect(detectRevert("fix: null pointer", "")).toBeNull();
  });
});
