import { describe, expect, it } from "vitest";
import {
  normalize,
  quarterLabelToRange,
  resolveQuarter,
  resolveTeam,
  selectTeams,
} from "../src/config.js";

describe("normalize (legacy single-team → multi-team)", () => {
  it("accepts legacy v0.1 shape and promotes it to teams[0]", () => {
    const cfg = normalize({
      github: {},
      org: "acme",
      repos: ["acme/one", "acme/two"],
      quarter: "2026Q1",
      team: { manager: "jdoe", members: ["alice", "bob"] },
    });
    expect(cfg.teams).toHaveLength(1);
    expect(cfg.teams[0]!.name).toBe("jdoe-team");
    expect(cfg.teams[0]!.members).toEqual(["alice", "bob"]);
    expect(cfg.teams[0]!.repos).toEqual(["acme/one", "acme/two"]);
    expect(cfg.defaults.quarter).toBe("2026Q1");
  });

  it("accepts multi-team shape with defaults", () => {
    const cfg = normalize({
      github: {},
      org: "acme",
      teams: [
        {
          name: "checkout",
          manager: "jdoe",
          members: ["alice"],
          repos: ["acme/checkout"],
        },
      ],
      defaults: { quarter: "2026Q1" },
    });
    expect(cfg.teams[0]!.name).toBe("checkout");
    expect(cfg.defaults.quarter).toBe("2026Q1");
  });

  it("accepts a team without members (auto-discovery)", () => {
    const cfg = normalize({
      github: {},
      org: "acme",
      teams: [
        { name: "checkout", manager: "jdoe", repos: ["acme/checkout"] },
      ],
      defaults: { quarter: "2026Q1" },
    });
    expect(cfg.teams[0]!.members).toBeUndefined();
  });

  it("rejects when neither shape matches", () => {
    expect(() =>
      normalize({
        github: {},
        org: "acme",
        // no teams and no legacy fields
      }),
    ).toThrow();
  });
});

describe("selectTeams", () => {
  const cfg = normalize({
    github: {},
    org: "acme",
    teams: [
      { name: "a", manager: "m1", members: ["x"], repos: ["acme/x"] },
      { name: "b", manager: "m2", members: ["y"], repos: ["acme/y"] },
    ],
    defaults: { quarter: "2026Q1" },
  });

  it("returns all teams when no filter", () => {
    expect(selectTeams(cfg, undefined)).toHaveLength(2);
  });
  it("filters to a named team", () => {
    expect(selectTeams(cfg, "a")).toHaveLength(1);
  });
  it("throws on unknown team with helpful message", () => {
    expect(() => selectTeams(cfg, "nope")).toThrow(/Known teams: a, b/);
  });
});

describe("resolveTeam", () => {
  it("inherits quarter/output/classification from defaults and allows per-team override", () => {
    const cfg = normalize({
      github: {},
      org: "acme",
      teams: [
        {
          name: "a",
          manager: "m",
          members: ["x"],
          repos: ["acme/x"],
          output: { dir: "./out/a" },
          classification: { bugfixLabels: ["urgent"] },
        },
      ],
      defaults: { quarter: "2026Q2" },
    });
    const r = resolveTeam(cfg, cfg.teams[0]!);
    expect(r.quarter.label).toBe("2026Q2");
    expect(r.output.dir).toBe("./out/a");
    expect(r.classification.bugfixLabels).toEqual(["urgent"]);
    expect(r.classification.featureLabels).toContain("feature");
  });
});

describe("quarterLabelToRange", () => {
  it("2026Q1 → Jan 1 .. Mar 31", () => {
    expect(quarterLabelToRange("2026Q1", "UTC")).toEqual({
      label: "2026Q1",
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });
  it("2026Q4 → Oct 1 .. Dec 31", () => {
    expect(quarterLabelToRange("2026Q4", "UTC")).toEqual({
      label: "2026Q4",
      from: "2026-10-01",
      to: "2026-12-31",
    });
  });
});

describe("resolveQuarter", () => {
  it("accepts explicit from/to", () => {
    const r = resolveQuarter({ from: "2026-02-15", to: "2026-05-15" }, "UTC");
    expect(r.from).toBe("2026-02-15");
    expect(r.to).toBe("2026-05-15");
  });
  it("throws when no quarter given", () => {
    expect(() => resolveQuarter(undefined, "UTC")).toThrow();
  });
});
