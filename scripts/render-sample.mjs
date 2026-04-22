#!/usr/bin/env node
// Renders the checked-in sample-output/*.md to .html using the real renderer.
// Run with: pnpm build && node scripts/render-sample.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mdToHtml } from "../dist/render.js";

const DIR = path.join(process.cwd(), "examples", "sample-output");
const files = [
  ["asmith-2026Q1.md", "asmith-2026Q1.html", "asmith — 2026Q1"],
  ["team-summary-2026Q1.md", "team-summary-2026Q1.html", "Team summary — 2026Q1"],
  ["manager-rollup-2026Q1.md", "manager-rollup-2026Q1.html", "Manager rollup — 2026Q1"],
];

for (const [src, dst, title] of files) {
  const md = await readFile(path.join(DIR, src), "utf8");
  const html = mdToHtml(md, title);
  await writeFile(path.join(DIR, dst), html, "utf8");
  console.log(`rendered ${dst}`);
}
