#!/usr/bin/env node
// Offline-safe preflight for an operator who just unpacked this archive.
// Verifies the host has the prerequisites in the order they would fail
// during a real install, with a clear remediation pointer for each
// failure. Reports findings to stdout; exits non-zero if anything is
// blocking.
//
// Usage:
//   node scripts/preflight.mjs
//
// This script makes ZERO network calls. It only reads files inside the
// project directory and `process` properties (Node version, env vars).
// Safe to run on an air-gapped host as a first sanity check before
// `pnpm install`.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [];
function check(name, fn, fix) {
  try {
    const result = fn();
    checks.push({ name, ok: true, info: result });
  } catch (err) {
    checks.push({
      name,
      ok: false,
      info: err instanceof Error ? err.message : String(err),
      fix,
    });
  }
}

// --- Prerequisite checks -----------------------------------------------

check(
  "Node version >= 22.13.0",
  () => {
    const v = process.versions.node.split(".").map(Number);
    if (
      v[0] < 22 ||
      (v[0] === 22 && v[1] < 13) ||
      (v[0] === 22 && v[1] === 13 && v[2] < 0)
    ) {
      throw new Error(`Node ${process.versions.node} is too old`);
    }
    return `Node ${process.versions.node}`;
  },
  "Install Node 22.13+ — see HANDOFF.md step 1.",
);

check(
  "package.json declares engines.node >= 22.13.0",
  () => {
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    const declared = pkg.engines?.node;
    if (!declared) throw new Error("missing engines.node");
    if (!/22\.13/.test(declared)) {
      throw new Error(`package.json says: ${declared}`);
    }
    return declared;
  },
  "package.json was tampered with — re-extract the archive.",
);

check(
  "src/ tree is present",
  () => {
    const must = [
      "src/cli.ts",
      "src/config.ts",
      "src/audit.ts",
      "src/version.ts",
      "src/templates/success-story.md.eta",
    ];
    const missing = must.filter((p) => !existsSync(path.join(ROOT, p)));
    if (missing.length > 0) {
      throw new Error(`missing files: ${missing.join(", ")}`);
    }
    return `${must.length} expected source files present`;
  },
  "Re-extract the archive cleanly into a fresh directory.",
);

check(
  "bin/shipreport.js shim is present and executable-shaped",
  () => {
    const p = path.join(ROOT, "bin", "shipreport.js");
    if (!existsSync(p)) throw new Error("bin/shipreport.js missing");
    const head = readFileSync(p, "utf8").split("\n")[0];
    if (!head.startsWith("#!/usr/bin/env node")) {
      throw new Error(`unexpected first line: ${head.slice(0, 40)}`);
    }
    return "OK";
  },
  "Re-extract the archive cleanly.",
);

check(
  "node_modules/ is populated",
  () => {
    if (!existsSync(path.join(ROOT, "node_modules"))) {
      throw new Error("node_modules/ missing");
    }
    return "present";
  },
  "Run `pnpm install --frozen-lockfile` (HANDOFF.md step 2).",
);

check(
  "dist/ is built",
  () => {
    if (!existsSync(path.join(ROOT, "dist", "cli.js"))) {
      throw new Error("dist/cli.js missing");
    }
    if (
      !existsSync(
        path.join(ROOT, "dist", "templates", "success-story.md.eta"),
      )
    ) {
      throw new Error("dist/templates/ missing — partial build?");
    }
    return "OK";
  },
  "Run `pnpm build` (HANDOFF.md step 2).",
);

check(
  "no leftover personal-handle markers",
  () => {
    // If something we're meant to ship as generic still references the
    // original maintainer's GitHub handle, surface it loudly. Only
    // checks files an operator could plausibly be confused by — not
    // node_modules, not pnpm-lock.yaml.
    const targets = [
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "LICENSE",
      "HANDOFF.md",
      ".github/CODEOWNERS",
      "package.json",
    ];
    const offenders = [];
    for (const f of targets) {
      const p = path.join(ROOT, f);
      if (!existsSync(p)) continue;
      const body = readFileSync(p, "utf8");
      if (/tomtom215\b/.test(body) || /\bTom F\b/.test(body)) {
        offenders.push(f);
      }
    }
    if (offenders.length > 0) {
      throw new Error(`stale personal handle in: ${offenders.join(", ")}`);
    }
    return "clean";
  },
  "If you see this, the archive was tampered with after handover.",
);

// --- Output ------------------------------------------------------------

let blocked = false;
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
console.log("shipreport preflight");
console.log("====================\n");
for (const c of checks) {
  if (c.ok) {
    console.log(`  ${pad("[ OK ]", 8)}${c.name}  — ${c.info}`);
  } else {
    blocked = true;
    console.log(`  ${pad("[FAIL]", 8)}${c.name}`);
    console.log(`           reason: ${c.info}`);
    if (c.fix) console.log(`           fix:    ${c.fix}`);
  }
}

console.log("");
if (blocked) {
  console.log("Preflight failed. Fix the items above and re-run.");
  process.exit(1);
}
console.log("Preflight OK. Next step: edit shipreport.yaml and run");
console.log("  node bin/shipreport.js doctor --config shipreport.yaml --offline");
