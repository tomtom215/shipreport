import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadConfig,
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
  it("2026Q1 → Jan 1 .. Mar 31 in UTC", () => {
    const r = quarterLabelToRange("2026Q1", "UTC");
    expect(r.from).toBe("2026-01-01");
    expect(r.to).toBe("2026-03-31");
    expect(r.label).toBe("2026Q1");
    expect(r.tz).toBe("UTC");
    expect(new Date(r.fromTs).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(r.toTs).toISOString()).toBe("2026-03-31T23:59:59.000Z");
  });
  it("2026Q4 → Oct 1 .. Dec 31 in UTC", () => {
    const r = quarterLabelToRange("2026Q4", "UTC");
    expect(r.from).toBe("2026-10-01");
    expect(r.to).toBe("2026-12-31");
    expect(new Date(r.fromTs).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(new Date(r.toTs).toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });
  it("resolves wall-clock Q boundaries in a non-UTC zone (America/New_York)", () => {
    const r = quarterLabelToRange("2026Q1", "America/New_York");
    // Jan 1 00:00 EST = 05:00 UTC; Mar 31 23:59:59 EDT (DST active by then) = Apr 1 03:59:59 UTC.
    expect(new Date(r.fromTs).toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(new Date(r.toTs).toISOString()).toBe("2026-04-01T03:59:59.000Z");
  });
  it("resolves Q4→Q1 year boundary in Pacific/Auckland (DST ends during Q1)", () => {
    // Dec 31 2025 23:59:59 NZDT (+13) = Dec 31 10:59:59 UTC.
    // Apr 1 (post-DST end) exhibits the DST-aware offset change.
    const q4 = quarterLabelToRange("2025Q4", "Pacific/Auckland");
    const q1 = quarterLabelToRange("2026Q1", "Pacific/Auckland");
    expect(new Date(q4.toTs).toISOString()).toBe("2025-12-31T10:59:59.000Z");
    // Q1 starts the millisecond after Q4 ends in the same zone.
    expect(q1.fromTs - q4.toTs).toBe(1000);
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
  it("honors timezone on explicit from/to ranges (America/New_York)", () => {
    const r = resolveQuarter(
      { from: "2026-02-15", to: "2026-05-15" },
      "America/New_York",
    );
    // Start in EST (-05:00), end in EDT (-04:00); absolute timestamps reflect
    // that offset change, so we can't assume 23:59:59 UTC.
    expect(new Date(r.fromTs).toISOString()).toBe("2026-02-15T05:00:00.000Z");
    expect(new Date(r.toTs).toISOString()).toBe("2026-05-16T03:59:59.000Z");
  });
  it("rejects a malformed quarter label", () => {
    expect(() => resolveQuarter("foo" as never, "UTC")).toThrow();
  });
});

describe("date range schema validation", () => {
  // The schema rejects `from > to` ranges — without this guard, an
  // operator typo silently produces zero PRs at extract time. See
  // docs/08-dry-run.md and docs/13-troubleshooting.md.
  it("accepts a range where from < to", () => {
    expect(() =>
      normalize({
        org: "acme",
        teams: [
          { name: "t", manager: "j", members: ["a"], repos: ["acme/r"] },
        ],
        defaults: { quarter: { from: "2026-01-01", to: "2026-03-31" } },
      }),
    ).not.toThrow();
  });

  it("accepts a single-day range where from == to", () => {
    expect(() =>
      normalize({
        org: "acme",
        teams: [
          { name: "t", manager: "j", members: ["a"], repos: ["acme/r"] },
        ],
        defaults: { quarter: { from: "2026-04-15", to: "2026-04-15" } },
      }),
    ).not.toThrow();
  });

  it("rejects a reversed range where from > to (defaults.quarter)", () => {
    expect(() =>
      normalize({
        org: "acme",
        teams: [
          { name: "t", manager: "j", members: ["a"], repos: ["acme/r"] },
        ],
        defaults: { quarter: { from: "2026-04-01", to: "2026-01-01" } },
      }),
    ).toThrow(/from.*must be on or before.*to/);
  });

  it("rejects a reversed range where from > to (team.quarter)", () => {
    expect(() =>
      normalize({
        org: "acme",
        teams: [
          {
            name: "t",
            manager: "j",
            members: ["a"],
            repos: ["acme/r"],
            quarter: { from: "2026-04-01", to: "2026-01-01" },
          },
        ],
        defaults: { quarter: "2026Q1" },
      }),
    ).toThrow(/from.*must be on or before.*to/);
  });
});

describe("loadConfig (file-on-disk path)", () => {
  it("reads YAML from a file and returns a normalized Config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shipreport-loadcfg-"));
    const file = path.join(dir, "shipreport.yaml");
    await writeFile(
      file,
      [
        "org: acme",
        "teams:",
        "  - name: t",
        "    manager: jdoe",
        "    members: [alice]",
        "    repos: [acme/one]",
        "defaults:",
        "  quarter: 2026Q1",
        "  timezone: UTC",
        "",
      ].join("\n"),
      "utf8",
    );
    const cfg = await loadConfig(file);
    expect(cfg.org).toBe("acme");
    expect(cfg.teams).toHaveLength(1);
    expect(cfg.teams[0]!.repos).toEqual(["acme/one"]);
  });

  it("propagates a clear error message when the file is invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shipreport-loadcfg-bad-"));
    const file = path.join(dir, "shipreport.yaml");
    await writeFile(file, "org: acme\nteams: []\n", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(/Invalid shipreport config/);
  });
});

describe("resolveHome", () => {
  it("expands a leading ~ to the OS home directory", async () => {
    const { resolveHome } = await import("../src/config.js");
    const out = resolveHome("~/.config/shipreport/key.pem");
    expect(out.startsWith("/")).toBe(true);
    expect(out.endsWith(".config/shipreport/key.pem")).toBe(true);
    expect(out).not.toContain("~");
  });

  it("absolutises a relative path without a leading ~", async () => {
    const { resolveHome } = await import("../src/config.js");
    const out = resolveHome("relative/path");
    expect(path.isAbsolute(out)).toBe(true);
  });
});
