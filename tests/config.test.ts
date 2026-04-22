import { describe, expect, it } from "vitest";
import { ConfigSchema, quarterLabelToRange, resolveQuarter } from "../src/config.js";

describe("ConfigSchema", () => {
  it("accepts a minimal valid config", () => {
    const cfg = ConfigSchema.parse({
      github: {},
      org: "acme",
      repos: ["acme/one"],
      quarter: "2026Q1",
      team: { manager: "jdoe", members: ["alice"] },
    });
    expect(cfg.github.baseUrl).toBe("https://api.github.com");
    expect(cfg.classification.bugfixLabels).toContain("bug");
  });

  it("rejects repos that aren't owner/name", () => {
    expect(() =>
      ConfigSchema.parse({
        github: {},
        org: "acme",
        repos: ["not-a-repo"],
        quarter: "2026Q1",
        team: { manager: "j", members: ["a"] },
      }),
    ).toThrow();
  });

  it("rejects malformed quarter labels", () => {
    expect(() =>
      ConfigSchema.parse({
        github: {},
        org: "acme",
        repos: ["a/b"],
        quarter: "2026-Q1",
        team: { manager: "j", members: ["a"] },
      }),
    ).toThrow();
  });
});

describe("quarterLabelToRange", () => {
  it("2026Q1 → Jan 1 .. Mar 31", () => {
    const r = quarterLabelToRange("2026Q1", "UTC");
    expect(r).toEqual({ label: "2026Q1", from: "2026-01-01", to: "2026-03-31" });
  });
  it("2026Q4 → Oct 1 .. Dec 31", () => {
    const r = quarterLabelToRange("2026Q4", "UTC");
    expect(r).toEqual({ label: "2026Q4", from: "2026-10-01", to: "2026-12-31" });
  });
});

describe("resolveQuarter", () => {
  it("accepts explicit from/to", () => {
    const r = resolveQuarter({ from: "2026-02-15", to: "2026-05-15" }, "UTC");
    expect(r.from).toBe("2026-02-15");
    expect(r.to).toBe("2026-05-15");
  });
});
