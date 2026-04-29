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

describe("narrate.talkingPoints — dominant-kind branches", () => {
  it("refactor-dominant quarter adds the investment-quarter point", () => {
    const n = narrate(
      dev({
        prsMerged: 5,
        prsByKind: { feature: 0, bugfix: 0, refactor: 5, docs: 0, infra: 0, other: 0 },
      }),
    );
    expect(n.talkingPoints.join("\n")).toMatch(/Investment quarter.*5 refactors/);
  });

  it("infra-dominant quarter adds the platform/infra point", () => {
    const n = narrate(
      dev({
        prsMerged: 4,
        prsByKind: { feature: 0, bugfix: 0, refactor: 0, docs: 0, infra: 4, other: 0 },
      }),
    );
    expect(n.talkingPoints.join("\n")).toMatch(/Platform\/infra quarter.*4 merged/);
  });
});

describe("narrate.talkingPoints — pluralization", () => {
  // Locks in the irregular-plural fix in src/narrate.ts: the bugfix
  // talking point used to read "1 fixes" when prsByKind.bugfix === 1.
  it("uses singular `fix` when bugfix count is exactly 1", () => {
    const n = narrate(
      dev({
        prsMerged: 1,
        prsByKind: { feature: 0, bugfix: 1, refactor: 0, docs: 0, infra: 0, other: 0 },
      }),
    );
    expect(n.talkingPoints.join("\n")).toMatch(/Reliability-focused quarter \(1 fix\)/);
    // Negative control: no inadvertent "1 fixes" leak.
    expect(n.talkingPoints.join("\n")).not.toMatch(/1 fixes/);
  });

  it("uses plural `fixes` when bugfix count is > 1", () => {
    const n = narrate(
      dev({
        prsMerged: 3,
        prsByKind: { feature: 0, bugfix: 3, refactor: 0, docs: 0, infra: 0, other: 0 },
      }),
    );
    expect(n.talkingPoints.join("\n")).toMatch(/3 fixes/);
  });

  it("uses singular `refactor` when refactor count is exactly 1", () => {
    const n = narrate(
      dev({
        prsMerged: 1,
        prsByKind: { feature: 0, bugfix: 0, refactor: 1, docs: 0, infra: 0, other: 0 },
      }),
    );
    expect(n.talkingPoints.join("\n")).toMatch(/Investment quarter \(1 refactor\)/);
    expect(n.talkingPoints.join("\n")).not.toMatch(/1 refactors/);
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
