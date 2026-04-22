#!/usr/bin/env node
import { mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";

const src = new URL("../src/templates/", import.meta.url);
const dst = new URL("../dist/templates/", import.meta.url);

if (!existsSync(src)) {
  console.error("no src/templates directory — nothing to copy");
  process.exit(0);
}

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log("templates copied → dist/templates/");
