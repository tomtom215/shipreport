#!/usr/bin/env node
// Renders the checked-in sample-output/*.md to .html AND .png using the real
// renderer. Requires `puppeteer` + Chrome installed (npx puppeteer browsers
// install chrome).
//   pnpm build && node scripts/render-sample.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mdToHtml, writeReport } from "../dist/render.js";

const DIR = path.join(process.cwd(), "examples", "sample-output");
const files = [
  ["asmith-2026Q1.md", "asmith-2026Q1", "asmith — 2026Q1"],
  ["team-summary-checkout-2026Q1.md", "team-summary-checkout-2026Q1", "Team summary — 2026Q1"],
  ["manager-rollup-checkout-2026Q1.md", "manager-rollup-checkout-2026Q1", "Manager rollup — 2026Q1"],
];

for (const [srcFile, basename, title] of files) {
  const md = await readFile(path.join(DIR, srcFile), "utf8");
  const written = await writeReport(DIR, basename, md, ["md", "html", "png"], title);
  for (const p of written) console.log(`  ${p}`);
}
// Silence unused-import warning in some lint configurations.
void mdToHtml;
