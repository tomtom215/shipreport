/**
 * Every YAML in examples/ should round-trip through the same Zod schema
 * loadConfig() uses. If a checked-in example would fail validation today,
 * the bundled `validate-config.yml` workflow would fail any operator who
 * copy-pasted it — so we catch that here.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { normalize } from "../../src/config.js";
import { parseCron } from "../../src/schedule.js";

const ROOT = path.resolve(__dirname, "..", "..");

describe("examples/*.yaml are valid against the live schema", () => {
  it.each(["shipreport.yaml", "vllm.yaml"])(
    "%s parses, normalizes, and every team's cron parses",
    async (name) => {
      const raw = await readFile(path.join(ROOT, "examples", name), "utf8");
      const cfg = normalize(parse(raw));
      expect(cfg.org.length).toBeGreaterThan(0);
      expect(cfg.teams.length).toBeGreaterThan(0);
      for (const t of cfg.teams) {
        if (t.schedule) {
          expect(() => parseCron(t.schedule!)).not.toThrow();
        }
      }
    },
  );

  it("every annotated example team declares either members or autoMembers (or omits for defaults)", async () => {
    const raw = await readFile(path.join(ROOT, "examples", "shipreport.yaml"), "utf8");
    const cfg = normalize(parse(raw));
    for (const t of cfg.teams) {
      // The annotated reference shows both patterns; this assertion just
      // confirms each team is actually runnable (has at least one identity
      // signal). autoMembers is allowed because run.ts will discover at
      // runtime.
      const ok = (t.members && t.members.length > 0) || t.autoMembers !== undefined;
      expect(ok, `team=${t.name} has neither members nor autoMembers`).toBe(true);
    }
  });

  it("examples/sample-output/*.md exist and are non-empty", async () => {
    const dir = path.join(ROOT, "examples", "sample-output");
    const entries = await readdir(dir);
    const mds = entries.filter((e) => e.endsWith(".md"));
    expect(mds.length).toBeGreaterThanOrEqual(3);
    for (const md of mds) {
      const body = await readFile(path.join(dir, md), "utf8");
      expect(body.length).toBeGreaterThan(50);
      // First line is a top-level heading or display name; never empty.
      expect(body.split("\n")[0]!.trim().length).toBeGreaterThan(0);
    }
  });
});
