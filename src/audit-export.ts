/**
 * Audit log export helpers.
 *
 * - exportJsonl(): emit each audit row as a single JSON object per line,
 *   in chain order. Downstream verifiers can stream this into an external
 *   WORM store (S3 Object Lock, Loki, etc.) and use `verifyJsonl()` to
 *   reconstruct the chain from nothing but the export file.
 */

import { canonicalize, sha256, type AuditRow } from "./audit.js";

export interface ExportedRow {
  seq: number;
  at: string;
  actor: string;
  event: string;
  target: string | null;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export function rowToExport(row: AuditRow): ExportedRow {
  return {
    seq: row.seq,
    at: row.at,
    actor: row.actor,
    event: row.event,
    target: row.target,
    payload: row.payload,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

/** Serialize rows to NDJSON. One row per line, LF-terminated, trailing LF. */
export function exportJsonl(rows: AuditRow[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => JSON.stringify(rowToExport(r))).join("\n") + "\n";
}

const ZERO = "0".repeat(64);

/**
 * Re-verify a JSONL export offline. Starts from `expectedPrev`:
 *   - "chain-head" mode: pass the genesis zero hash; works only when the
 *     export spans from seq=1.
 *   - "partial" mode: pass the prev_hash of the first exported row so a
 *     verifier can validate an incremental export slotted onto a chain
 *     they've already anchored.
 */
export function verifyJsonl(
  jsonl: string,
  expectedPrev: string = ZERO,
): { ok: true; rows: number } | { ok: false; brokeAtSeq: number; reason: string } {
  const lines = jsonl.split("\n").filter((l) => l.length > 0);
  let prev = expectedPrev;
  for (const line of lines) {
    let row: ExportedRow;
    try {
      row = JSON.parse(line) as ExportedRow;
    } catch {
      return { ok: false, brokeAtSeq: -1, reason: "malformed json" };
    }
    if (row.prevHash !== prev) {
      return { ok: false, brokeAtSeq: row.seq, reason: "prev_hash mismatch" };
    }
    const canonical = canonicalize({
      at: row.at,
      actor: row.actor,
      event: row.event,
      target: row.target,
      payload: row.payload,
      prevHash: row.prevHash,
    });
    if (sha256(canonical) !== row.hash) {
      return { ok: false, brokeAtSeq: row.seq, reason: "row hash mismatch" };
    }
    prev = row.hash;
  }
  return { ok: true, rows: lines.length };
}
