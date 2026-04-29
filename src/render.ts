import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import MarkdownIt from "markdown-it";
import { narrate } from "./narrate.js";
import type { DevQuarter, TeamQuarter } from "./types.js";
import { VERSION } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pick the first existing directory from the candidate list, or fall
 * back to the first one (so Eta produces a clear "template not found"
 * error rather than a generic ENOENT). Exported for tests so the
 * fallback branch is exercised without monkey-patching `fs`.
 */
export function resolveTemplateDir(
  candidates: ReadonlyArray<string> = [
    path.join(__dirname, "templates"),
    path.join(__dirname, "..", "src", "templates"),
  ],
): string {
  for (const c of candidates) if (existsSync(c)) return c;
  if (candidates.length === 0) {
    throw new Error("resolveTemplateDir: no candidates supplied");
  }
  return candidates[0]!;
}

const eta = new Eta({
  views: resolveTemplateDir(),
  autoEscape: false,
  autoTrim: false,
  cache: true,
});

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export interface RenderContext {
  version: string;
  generatedAt: string;
}

/**
 * Template-side formatting helpers. Exported so that templates have one
 * canonical place to do per-value coercions (date trimming, pluralization,
 * first-paragraph extraction) — and so unit tests can lock the behaviour
 * down without spinning up Eta.
 */
export const fmt = {
  date(iso: string): string {
    if (!iso) return "—";
    return iso.slice(0, 10);
  },
  firstParagraph(body: string): string {
    if (!body) return "";
    const trimmed = body.trim();
    if (!trimmed) return "";
    const first = trimmed.split(/\n\s*\n/)[0]!.trim();
    // Strip a leading markdown heading marker and any per-line block-quote
    // markers from the first paragraph so the "Why it mattered" excerpt
    // reads as prose. Issue-link trailers like "Fixes #123" are usually
    // in their own paragraph and never reach here.
    return first.replace(/^#+\s*/, "").replace(/^\s*>\s?/gm, "");
  },
  /**
   * Pick singular vs plural form based on `n`. Templates were carrying
   * inline ternaries on `n === 1` for a few words ("service"/"services")
   * and not for others ("PRs"/"reviews"/"issues"), producing user-visible
   * "1 services" output in `manager-rollup.md.eta`. Centralising the
   * logic here keeps every template consistent.
   *
   * `n` is a real number (co-author credit can be fractional under the
   * `split` mode), so the threshold is "exactly 1.0" — `0.5` and `1.5`
   * both take the plural form, which matches English usage ("0.5 PRs",
   * "1.5 PRs").
   */
  plural(n: number, singular: string, plural?: string): string {
    return n === 1 ? singular : (plural ?? `${singular}s`);
  },
};

export async function renderDev(
  dev: DevQuarter,
  quarter: TeamQuarter["quarter"],
  team: TeamQuarter,
  ctx: RenderContext,
): Promise<string> {
  const out = await eta.renderAsync("success-story.md.eta", {
    dev,
    quarter,
    team,
    narration: narrate(dev),
    fmt,
    version: ctx.version,
    generatedAt: ctx.generatedAt,
  });
  return out ?? "";
}

export async function renderTeamSummary(
  team: TeamQuarter,
  ctx: RenderContext,
): Promise<string> {
  const out = await eta.renderAsync("team-summary.md.eta", {
    team,
    fmt,
    version: ctx.version,
    generatedAt: ctx.generatedAt,
  });
  return out ?? "";
}

export async function renderManagerRollup(
  team: TeamQuarter,
  ctx: RenderContext,
): Promise<string> {
  const out = await eta.renderAsync("manager-rollup.md.eta", {
    team,
    fmt,
    version: ctx.version,
    generatedAt: ctx.generatedAt,
  });
  return out ?? "";
}

export function mdToHtml(markdown: string, title: string): string {
  const body = md.render(markdown);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2em auto; padding: 0 1em; color: #222; }
  h1,h2,h3 { line-height: 1.25; }
  h1 { border-bottom: 2px solid #111; padding-bottom: .25em; }
  h2 { margin-top: 1.8em; border-bottom: 1px solid #ddd; padding-bottom: .2em; }
  code { background: #f3f3f3; padding: 0 .3em; border-radius: 3px; }
  a { color: #0366d6; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: .4em .7em; text-align: left; }
  th { background: #f6f8fa; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  em { color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export async function writeReport(
  dir: string,
  basename: string,
  markdown: string,
  formats: ReadonlyArray<"md" | "html" | "pdf" | "png">,
  title: string,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];

  if (formats.includes("md")) {
    const p = path.join(dir, `${basename}.md`);
    await writeFile(p, markdown, "utf8");
    written.push(p);
  }

  let html: string | null = null;
  if (formats.includes("html") || formats.includes("pdf") || formats.includes("png")) {
    html = mdToHtml(markdown, title);
  }

  if (formats.includes("html") && html) {
    const p = path.join(dir, `${basename}.html`);
    await writeFile(p, html, "utf8");
    written.push(p);
  }

  /* c8 ignore start — pdf/png delegate to the c8-ignored chromium path
     below; the gating itself is one boolean check per format and is
     exercised end-to-end by the WITH_PDF=1 Docker smoke test. */
  if (formats.includes("pdf") && html) {
    const pdfPath = path.join(dir, `${basename}.pdf`);
    await renderPdf(html, pdfPath);
    written.push(pdfPath);
  }

  if (formats.includes("png") && html) {
    const pngPath = path.join(dir, `${basename}.png`);
    await renderPng(html, pngPath);
    written.push(pngPath);
  }
  /* c8 ignore stop */

  return written;
}

/* c8 ignore start — optional puppeteer path requires Chrome at runtime;
   exercised by the build-arg WITH_PDF=1 Docker smoke test, not unit tests. */
async function launchChromium(): Promise<{
  browser: import("puppeteer").Browser;
  close: () => Promise<void>;
}> {
  let puppeteer: typeof import("puppeteer") | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    puppeteer = (await import("puppeteer")) as any;
  } catch {
    throw new Error(
      "PDF/PNG output requires the optional `puppeteer` dependency. Install with `pnpm add puppeteer`.",
    );
  }
  // Chromium's sandbox is the primary defence-in-depth around the
  // renderer process. Drop it ONLY when we have to: inside a container
  // running as a non-root user without CAP_SYS_ADMIN (the Dockerfile's
  // runtime), or when an operator opts in explicitly. The opt-in env
  // var is documented in docs/14-security.md.
  const inDocker = existsSync("/.dockerenv");
  const optedIn = process.env.SHIPREPORT_NO_SANDBOX === "1";
  const args: string[] = [];
  if (inDocker || optedIn) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  const browser = await puppeteer!.launch({ headless: true, args });
  return { browser, close: () => browser.close() };
}

async function renderPdf(html: string, outPath: string): Promise<void> {
  const { browser, close } = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.pdf({
      path: outPath,
      format: "Letter",
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    });
  } finally {
    await close();
  }
}

async function renderPng(html: string, outPath: string): Promise<void> {
  const { browser, close } = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: outPath as `${string}.png`, fullPage: true, type: "png" });
  } finally {
    await close();
  }
}
/* c8 ignore stop */

/**
 * Resolve the running shipreport version. Sourced from src/version.ts so
 * that the CLI meta, the GitHub User-Agent, and the report footer all
 * stamp the same string. Async wrapper retained for backwards-compat
 * with run.ts; see src/version.ts for the single point of truth.
 */
export async function readPackageVersion(): Promise<string> {
  return VERSION;
}
