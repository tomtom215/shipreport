/**
 * Schema-completeness regression test for the AuditEvent enum.
 *
 * Past failure mode: `token_renewed` and `extract_checkpointed` were
 * declared in src/audit.ts and documented in docs/12-audit-log.md but
 * no production code path ever called `audit.append({event: ...})`
 * with them. The chain therefore never recorded what the docs promised
 * — a SOC2 evidence gap that wouldn't have been caught by line-coverage
 * thresholds (the events file itself was 100%).
 *
 * This test grep-walks every src/ file (except audit.ts where the
 * literal declarations live) and asserts each AuditEvent name appears
 * verbatim in at least one. A new event added to the enum without a
 * call site fails the build until the call site exists.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TESTS_DIR, "..", "src");

async function listSrcFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".ts")) continue;
    if (e.name === "audit.ts") continue; // declarations live here
    out.push(path.join(SRC_DIR, e.name));
  }
  return out;
}

async function readAuditEventNames(): Promise<string[]> {
  const src = await readFile(path.join(SRC_DIR, "audit.ts"), "utf8");
  // Locate the union literal block: `export type AuditEvent = "x" | "y" | …;`
  const m = /export type AuditEvent\s*=\s*([\s\S]*?);/m.exec(src);
  if (!m) throw new Error("Could not locate AuditEvent union in src/audit.ts");
  const names = [...m[1]!.matchAll(/"([^"]+)"/g)].map((mm) => mm[1]!);
  if (names.length === 0) throw new Error("AuditEvent union appears empty");
  return names;
}

describe("every declared AuditEvent has a call site in src/", () => {
  it("each name appears literally in at least one production file", async () => {
    const events = await readAuditEventNames();
    const files = await listSrcFiles();
    const haystack = new Map<string, string>();
    for (const f of files) haystack.set(f, await readFile(f, "utf8"));

    const missing: string[] = [];
    for (const ev of events) {
      const literal = `"${ev}"`;
      const found = [...haystack.values()].some((src) => src.includes(literal));
      if (!found) missing.push(ev);
    }

    expect(missing, `These AuditEvent names are declared in src/audit.ts but no other src/*.ts file emits them. Either add an audit.append() call or remove the enum entry: ${missing.join(", ")}`).toEqual([]);
  });
});
