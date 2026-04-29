#!/usr/bin/env node
// Renders every checked-in sample-output/*.md to .html using the real
// renderer. Optional .png output requires `puppeteer` + Chrome installed,
// which are NOT part of shipreport's default install (see docs/06-config.md):
//   pnpm add puppeteer
//   npx puppeteer browsers install chrome
//
// Usage:
//   pnpm build && node scripts/render-sample.mjs           # md → html
//   pnpm build && node scripts/render-sample.mjs --png     # also emit .png
//
// The script imports from `dist/`, so a fresh checkout has to build
// first. Rather than failing with a confusing ERR_MODULE_NOT_FOUND on
// `../dist/render.js`, we detect the missing build and run `pnpm build`
// inline (same pattern as tests/e2e/validate-config-script.test.ts).
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_RENDER = path.join(ROOT, "dist", "render.js");

if (!existsSync(DIST_RENDER)) {
  console.error("dist/render.js missing — running `pnpm build` first.");
  await exec("pnpm", ["build"], { cwd: ROOT });
  if (!existsSync(DIST_RENDER)) {
    throw new Error(
      `dist/render.js still missing after \`pnpm build\` — refusing to proceed.`,
    );
  }
}

const { mdToHtml, writeReport } = await import("../dist/render.js");

const DIR = path.join(ROOT, "examples", "sample-output");
const wantPng = process.argv.includes("--png");
const formats = wantPng ? ["md", "html", "png"] : ["md", "html"];

// Auto-discover every .md file in the sample-output directory rather
// than maintaining a stale hard-coded list. Title is inferred from the
// filename's leading segment so the rendered HTML's <title> reads
// sensibly without a per-file lookup table.
const entries = (await readdir(DIR))
  .filter((e) => e.endsWith(".md"))
  .sort();

if (entries.length === 0) {
  console.error(`No .md files in ${DIR}; nothing to render.`);
  process.exit(0);
}

for (const file of entries) {
  const basename = file.replace(/\.md$/, "");
  const title = basename
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const md = await readFile(path.join(DIR, file), "utf8");
  const written = await writeReport(DIR, basename, md, formats, title);
  for (const p of written) console.log(`  ${p}`);
}
// Silence unused-import warning in some lint configurations.
void mdToHtml;
