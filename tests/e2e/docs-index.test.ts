/**
 * Lightweight contract tests for the docs/ tree.
 *
 * The user-facing index in docs/README.md links to a numbered set of
 * pages; if any of those pages are missing, every link in the matrix
 * would 404 in the operator's Markdown viewer. This file enforces:
 *   * the expected set of pages exists,
 *   * each page is non-empty,
 *   * each page links forward (or to the index) and back (or to the
 *     index) so an operator never hits a dead end,
 *   * every example workflow file referenced in the docs actually exists.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const DOCS = path.join(ROOT, "docs");

const EXPECTED_PAGES = [
  "00-overview.md",
  "01-prerequisites.md",
  "02-quickstart.md",
  "03-auth-pat.md",
  "04-auth-github-app.md",
  "05-auth-ghes.md",
  "06-config.md",
  "07-scheduling.md",
  "08-dry-run.md",
  "09-deployment-github-actions.md",
  "10-deployment-docker.md",
  "11-deployment-local-cron.md",
  "12-audit-log.md",
  "13-troubleshooting.md",
  "14-security.md",
  "15-faq.md",
];

describe("docs/ index integrity", () => {
  it("every expected page exists and is non-empty", async () => {
    for (const page of EXPECTED_PAGES) {
      const p = path.join(DOCS, page);
      const s = await stat(p);
      expect(s.isFile(), `${page} missing`).toBe(true);
      expect(s.size, `${page} is empty`).toBeGreaterThan(500);
    }
  });

  it("docs/README.md links to every expected page", async () => {
    const readme = await readFile(path.join(DOCS, "README.md"), "utf8");
    for (const page of EXPECTED_PAGES) {
      expect(readme, `index missing link to ${page}`).toContain(`./${page}`);
    }
  });

  it("each page (except the index) provides forward / back navigation", async () => {
    for (const page of EXPECTED_PAGES) {
      const body = await readFile(path.join(DOCS, page), "utf8");
      // Check for the breadcrumb pattern used at the top of every doc.
      expect(body, `${page} lacks navigation breadcrumb`).toMatch(
        /\[Index\]\(\.\/README\.md\)/,
      );
    }
  });

  it("docs/ contains exactly the expected pages plus README (no orphans)", async () => {
    const entries = (await readdir(DOCS)).filter((e) => e.endsWith(".md")).sort();
    const expected = ["README.md", ...EXPECTED_PAGES].sort();
    expect(entries).toEqual(expected);
  });

  it("every example workflow referenced from a doc page actually exists", async () => {
    // Surface relative refs to ../examples/github-actions/<file>.yml from any doc.
    const re = /\.\.\/examples\/github-actions\/([a-z0-9-]+\.yml)/g;
    for (const page of EXPECTED_PAGES) {
      const body = await readFile(path.join(DOCS, page), "utf8");
      const seen = new Set<string>();
      for (const m of body.matchAll(re)) seen.add(m[1]!);
      for (const file of seen) {
        const p = path.join(ROOT, "examples", "github-actions", file);
        const s = await stat(p).catch(() => null);
        expect(s?.isFile(), `${page} references missing example ${file}`).toBe(true);
      }
    }
  });

  it("every workflow file referenced from a doc page actually exists", async () => {
    const re = /\.\.\/.github\/workflows\/([a-z0-9-]+\.yml)/g;
    for (const page of EXPECTED_PAGES) {
      const body = await readFile(path.join(DOCS, page), "utf8");
      const seen = new Set<string>();
      for (const m of body.matchAll(re)) seen.add(m[1]!);
      for (const file of seen) {
        const p = path.join(ROOT, ".github", "workflows", file);
        const s = await stat(p).catch(() => null);
        expect(s?.isFile(), `${page} references missing workflow ${file}`).toBe(true);
      }
    }
  });
});
