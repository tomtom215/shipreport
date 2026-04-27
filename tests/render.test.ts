import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mdToHtml,
  readPackageVersion,
  resolveTemplateDir,
  writeReport,
} from "../src/render.js";

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "shipreport-render-"));
}

describe("mdToHtml", () => {
  it("wraps rendered markdown in a standalone HTML document with the given title", () => {
    const html = mdToHtml("# Hi\n\nbody", "Report Title");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>Report Title</title>");
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain("<p>body</p>");
  });

  it("escapes each of & < > \" ' in the title (covers every branch of escapeHtml)", () => {
    const html = mdToHtml("x", `Tom & "Alice" <span>'hi'</span>`);
    expect(html).toContain(
      "<title>Tom &amp; &quot;Alice&quot; &lt;span&gt;&#39;hi&#39;&lt;/span&gt;</title>",
    );
  });
});

describe("writeReport", () => {
  it("writes only the formats explicitly requested", async () => {
    const dir = await freshDir();
    const written = await writeReport(dir, "alice-2026Q1", "# Hi", ["md"], "Alice Q1");
    expect(written).toHaveLength(1);
    expect(written[0]!.endsWith("alice-2026Q1.md")).toBe(true);
    expect(await readFile(written[0]!, "utf8")).toBe("# Hi");
    expect(await readdir(dir)).toEqual(["alice-2026Q1.md"]);
  });

  it("emits html (derived from markdown) alongside md when both are requested", async () => {
    const dir = await freshDir();
    const written = await writeReport(
      dir,
      "alice",
      "# Hi",
      ["md", "html"],
      "Alice",
    );
    expect(written).toHaveLength(2);
    const htmlPath = written.find((p) => p.endsWith(".html"))!;
    const html = await readFile(htmlPath, "utf8");
    expect(html).toContain("<title>Alice</title>");
    expect(html).toContain("<h1>Hi</h1>");
  });

  it("creates the output directory if it doesn't already exist", async () => {
    const parent = await freshDir();
    const nested = path.join(parent, "a", "b", "c");
    const written = await writeReport(nested, "x", "# x", ["md"], "X");
    expect(written).toHaveLength(1);
    expect(written[0]!.startsWith(nested)).toBe(true);
  });

  it("returns an empty list when no formats are requested", async () => {
    const dir = await freshDir();
    const written = await writeReport(dir, "x", "# x", [], "X");
    expect(written).toEqual([]);
  });
});

describe("readPackageVersion", () => {
  it("returns the running package's declared version", async () => {
    const v = await readPackageVersion();
    // Not asserting the exact number so the test tolerates future bumps;
    // just that we get a non-fallback semver-ish string.
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toBe("0.0.0");
  });
});

describe("resolveTemplateDir", () => {
  it("returns the first existing candidate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shipreport-tpl-"));
    expect(resolveTemplateDir([dir, "/definitely/missing/x"])).toBe(dir);
  });

  it("falls back to the first candidate when none exist (lets Eta surface a clean ENOENT)", () => {
    const fake = "/tmp/shipreport-test-no-such-dir-existence-check";
    expect(resolveTemplateDir([fake, "/another/missing/x"])).toBe(fake);
  });

  it("throws when given an empty candidate list", () => {
    expect(() => resolveTemplateDir([])).toThrow(/no candidates supplied/);
  });
});
