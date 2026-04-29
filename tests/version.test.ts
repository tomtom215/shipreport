/**
 * Regression tests for the single-source-of-truth version pipeline.
 *
 * Past failure mode: src/cli.ts and src/github.ts each carried their
 * own hard-coded version literal ("0.2.0", "shipreport/0.2"). A
 * package.json bump silently desynced --version output and the
 * outbound User-Agent. These tests anchor every consumer to package.json
 * so the next bump is one edit + a green test, not a hunt.
 */
import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { VERSION, USER_AGENT, readVersionSync } from "../src/version.js";
import { main } from "../src/cli.js";

async function readPackageJson(): Promise<{ version: string }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  return JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
}

describe("version is sourced from package.json everywhere", () => {
  it("VERSION matches package.json#version exactly", async () => {
    const pkg = await readPackageJson();
    expect(VERSION).toBe(pkg.version);
  });

  it("USER_AGENT is `shipreport/<version>`", async () => {
    const pkg = await readPackageJson();
    expect(USER_AGENT).toBe(`shipreport/${pkg.version}`);
  });

  it("the citty root command's meta.version reads from VERSION", async () => {
    const pkg = await readPackageJson();
    // citty's `defineCommand` returns a CommandDef whose `meta` may
    // be a value, a function, or a promise. Resolve uniformly.
    const meta =
      typeof main.meta === "function" ? await main.meta() : await main.meta;
    expect(meta?.version).toBe(pkg.version);
  });

  it("VERSION is a non-empty semver-shaped string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
  });

  it("readVersionSync throws loudly on a missing/empty/non-string version field", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-version-"));
    const missing = path.join(dir, "missing.json");
    await writeFile(missing, JSON.stringify({ name: "x" }));
    expect(() => readVersionSync(missing)).toThrow(/no usable "version" field/);

    const empty = path.join(dir, "empty.json");
    await writeFile(empty, JSON.stringify({ version: "" }));
    expect(() => readVersionSync(empty)).toThrow(/no usable "version" field/);

    const wrongType = path.join(dir, "wrong.json");
    await writeFile(wrongType, JSON.stringify({ version: 42 }));
    expect(() => readVersionSync(wrongType)).toThrow(/no usable "version" field/);
  });

  it("token-source's app installation discovery imports USER_AGENT (no hardcoded UA)", async () => {
    // Source-level guard: the App-installation lookup `fetch` must use
    // the version.ts USER_AGENT constant. A literal string here would
    // silently drift from --version output on the next release bump.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = await readFile(
      path.join(here, "..", "src", "token-source.ts"),
      "utf8",
    );
    expect(src).toContain('import { USER_AGENT } from "./version.js"');
    expect(src).toContain('"user-agent": USER_AGENT');
    // And there must be no remaining literal "shipreport"-only UA.
    expect(src).not.toMatch(/"user-agent":\s*"shipreport"\s*,/);
  });
});
