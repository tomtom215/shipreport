import { describe, expect, it } from "vitest";
import { classifyPR } from "../src/classify.js";
import type { RawPR } from "../src/types.js";

const cfg = {
  bugfixLabels: ["bug", "hotfix", "p0", "p1"],
  featureLabels: ["feature", "enhancement"],
  infraLabels: ["ci", "build", "devops", "infra"],
  docsLabels: ["docs", "documentation"],
};

function pr(overrides: Partial<RawPR>): RawPR {
  return {
    repo: "o/r",
    number: 1,
    url: "https://example/1",
    title: "",
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
    ...overrides,
  };
}

describe("classifyPR", () => {
  it("labels win over title", () => {
    expect(classifyPR(pr({ title: "feat: x", labels: [{ name: "bug" }] }), cfg)).toBe("bugfix");
  });

  it("bugfix label is recognized case-insensitively", () => {
    expect(classifyPR(pr({ title: "", labels: [{ name: "Bug" }] }), cfg)).toBe("bugfix");
  });

  it("conventional-commit feat → feature", () => {
    expect(classifyPR(pr({ title: "feat(checkout): apple pay" }), cfg)).toBe("feature");
  });

  it("conventional-commit fix → bugfix", () => {
    expect(classifyPR(pr({ title: "fix: null pointer" }), cfg)).toBe("bugfix");
  });

  it("conventional-commit refactor → refactor", () => {
    expect(classifyPR(pr({ title: "refactor(api): extract helpers" }), cfg)).toBe("refactor");
  });

  it("conventional-commit perf → refactor", () => {
    expect(classifyPR(pr({ title: "perf: faster render" }), cfg)).toBe("refactor");
  });

  it("conventional-commit docs → docs", () => {
    expect(classifyPR(pr({ title: "docs: readme" }), cfg)).toBe("docs");
  });

  it("conventional-commit ci/build/chore → infra", () => {
    expect(classifyPR(pr({ title: "ci: pin action" }), cfg)).toBe("infra");
    expect(classifyPR(pr({ title: "build: bump deps" }), cfg)).toBe("infra");
    expect(classifyPR(pr({ title: "chore: tidy" }), cfg)).toBe("infra");
  });

  it("breaking marker ! still classifies", () => {
    expect(classifyPR(pr({ title: "feat!: drop v1" }), cfg)).toBe("feature");
  });

  it("unrecognized title and no labels → other", () => {
    expect(classifyPR(pr({ title: "random update" }), cfg)).toBe("other");
  });

  it("feature label without conventional-commit → feature", () => {
    expect(classifyPR(pr({ title: "add a thing", labels: [{ name: "enhancement" }] }), cfg)).toBe(
      "feature",
    );
  });

  it("bugfix label priority over feature label", () => {
    expect(
      classifyPR(pr({ labels: [{ name: "bug" }, { name: "feature" }] }), cfg),
    ).toBe("bugfix");
  });
});
