/**
 * Single source of truth for the shipreport version + User-Agent.
 *
 * Read once at import time from the installed package.json so the CLI
 * meta, the Octokit User-Agent, and the report-footer stamp all reflect
 * whatever version was published. A version bump is therefore a single
 * edit in package.json + tests/version.test.ts asserts the rest follows.
 *
 * Locating package.json is robust to two install layouts:
 *   - built tarball: <pkg>/dist/version.js          → ../package.json
 *   - source / tsx:  <pkg>/src/version.ts           → ../package.json
 * Both resolve to the same file via `..`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read and validate the `version` field from a package.json on disk.
 * Exported (rather than left module-private) so tests can exercise the
 * throw path with a synthetic broken file without needing to corrupt
 * the real one.
 */
export function readVersionSync(pkgPath: string): string {
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`package.json at ${pkgPath} has no usable "version" field`);
  }
  return pkg.version;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION: string = readVersionSync(path.join(HERE, "..", "package.json"));

/** Octokit / fetch User-Agent. Stable shape: `shipreport/<semver>`. */
export const USER_AGENT: string = `shipreport/${VERSION}`;
