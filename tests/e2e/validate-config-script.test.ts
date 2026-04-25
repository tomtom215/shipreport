/**
 * E2E for scripts/validate-config.mjs — the script the validate-config.yml
 * GH workflow runs on every PR. It depends on `pnpm build` having run
 * (it loads from dist/). If dist/ is missing we build inline rather than
 * silently skipping, so a green test always means the script was exercised.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "validate-config.mjs");
const DIST_CONFIG = path.join(ROOT, "dist", "config.js");

beforeAll(async () => {
  if (existsSync(DIST_CONFIG)) return;
  // Build once for the whole suite. `pnpm build` is idempotent; we'd
  // rather pay 5s here than have the test silently skip and lie about
  // green coverage. Timeout matches the build's typical worst case.
  await exec("pnpm", ["build"], { cwd: ROOT, timeout: 60_000 });
  if (!existsSync(DIST_CONFIG)) {
    throw new Error(
      `dist/config.js still missing after \`pnpm build\` — refusing to skip.`,
    );
  }
}, 90_000);

describe("validate-config.mjs", () => {
  it("accepts the annotated example shipreport.yaml", async () => {
    const cfg = path.join(ROOT, "examples", "shipreport.yaml");
    const { stdout } = await exec("node", [SCRIPT, cfg]);
    expect(stdout).toContain("OK");
    expect(stdout).toMatch(/team\(s\) parsed against schema/);
  });

  it("accepts the public-repo demo vllm.yaml", async () => {
    const cfg = path.join(ROOT, "examples", "vllm.yaml");
    const { stdout } = await exec("node", [SCRIPT, cfg]);
    expect(stdout).toContain("OK");
  });

  it("rejects a malformed config with a non-zero exit", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "shipreport-validate-"));
    const bad = path.join(tmp, "bad.yaml");
    await writeFile(
      bad,
      "org: foo\nteams: []\n", // empty teams list — schema rejects
      "utf8",
    );
    let threw = false;
    try {
      await exec("node", [SCRIPT, bad]);
    } catch (err) {
      threw = true;
      const e = err as { code?: number; stderr?: string };
      expect(e.code).toBe(1);
      expect(e.stderr ?? "").toContain("Validation failed");
    }
    expect(threw).toBe(true);
  });

  it("rejects a config with a malformed cron with a non-zero exit", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "shipreport-validate-cron-"));
    const bad = path.join(tmp, "bad.yaml");
    await writeFile(
      bad,
      [
        "org: o",
        "teams:",
        "  - name: t",
        "    manager: a",
        "    members: [a]",
        "    repos: [o/r]",
        "    schedule: '* * * * *'", // valid syntax → should pass actually
        "defaults: { quarter: 2026Q1 }",
        "",
      ].join("\n"),
      "utf8",
    );
    // The above is valid; switch to an actually-invalid cron:
    await writeFile(
      bad,
      [
        "org: o",
        "teams:",
        "  - name: t",
        "    manager: a",
        "    members: [a]",
        "    repos: [o/r]",
        "    schedule: 'foo bar baz'",
        "defaults: { quarter: 2026Q1 }",
        "",
      ].join("\n"),
      "utf8",
    );
    let threw = false;
    try {
      await exec("node", [SCRIPT, bad]);
    } catch (err) {
      threw = true;
      const e = err as { code?: number; stdout?: string; stderr?: string };
      expect(e.code).toBe(1);
      const all = (e.stdout ?? "") + (e.stderr ?? "");
      expect(all).toMatch(/cron=.*FAILED/);
    }
    expect(threw).toBe(true);
  });

  it("usage error (missing arg) exits with code 2", async () => {
    let threw = false;
    try {
      await exec("node", [SCRIPT]);
    } catch (err) {
      threw = true;
      expect((err as { code?: number }).code).toBe(2);
    }
    expect(threw).toBe(true);
  });
});

describe("validate-config.mjs script file metadata", () => {
  it("file exists and starts with a node shebang", async () => {
    const s = await stat(SCRIPT);
    expect(s.isFile()).toBe(true);
    const head = (await import("node:fs/promises")).readFile;
    const body = await head(SCRIPT, "utf8");
    expect(body.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
