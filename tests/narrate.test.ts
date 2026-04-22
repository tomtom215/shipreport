import { describe, expect, it } from "vitest";
import { narrate } from "../src/narrate.js";
import type { DevQuarter } from "../src/types.js";

function dev(over: Partial<DevQuarter>): DevQuarter {
  return {
    login: "alice",
    displayName: "alice",
    prsMerged: 0,
    prsByKind: { feature: 0, bugfix: 0, refactor: 0, docs: 0, infra: 0, other: 0 },
    filesTouched: 0,
    reviewsGiven: 0,
    reviewsOnOwnPRs: 0,
    crossRepoCollaboration: 0,
    topPRs: [],
    shippedMilestones: [],
    linkedIssuesClosed: [],
    ...over,
  };
}

describe("narrate.headline", () => {
  it("milestone path wins when ≥3 features + milestones", () => {
    const n = narrate(
      dev({
        prsMerged: 10,
        prsByKind: { feature: 4, bugfix: 0, refactor: 0, docs: 0, infra: 0, other: 0 },
        shippedMilestones: ["Launch A", "Launch B"],
        crossRepoCollaboration: 3,
      }),
    );
    expect(n.headline).toContain("2 milestones");
    expect(n.headline).toContain("3 services");
  });

  it("reviewer path wins at reviewsGiven >= 20", () => {
    const n = narrate(dev({ prsMerged: 5, reviewsGiven: 22 }));
    expect(n.headline).toMatch(/Anchored team quality with 22 code reviews/);
  });

  it("stabilization path on bugfix-heavy quarter", () => {
    const n = narrate(
      dev({
        prsMerged: 8,
        prsByKind: { feature: 1, bugfix: 7, refactor: 0, docs: 0, infra: 0, other: 0 },
        crossRepoCollaboration: 2,
      }),
    );
    expect(n.headline).toMatch(/Closed out 7 bugs/);
  });

  it("zero PRs path returns a note, not a fake headline", () => {
    const n = narrate(dev({}));
    expect(n.headline).toMatch(/No merged PRs/);
    expect(n.talkingPoints.some((p) => /leave/.test(p))).toBe(true);
  });
});

describe("narrate.collaboration", () => {
  it("mentions cross-service contribution when > 1 repo", () => {
    const n = narrate(dev({ crossRepoCollaboration: 3, reviewsGiven: 1, prsMerged: 1 }));
    expect(n.collaboration).toMatch(/3 different services/);
  });

  it("fallback when no collaboration signal", () => {
    const n = narrate(dev({ prsMerged: 2, crossRepoCollaboration: 1 }));
    expect(n.collaboration).toMatch(/individual delivery/);
  });
});
