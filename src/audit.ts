import { createHash } from "node:crypto";
import type { StateDB } from "./state.js";

/**
 * SOC2-oriented audit log.
 *
 * Design:
 *   - Append-only. There is no update or delete path.
 *   - Each row stores a sha256 hash of its own canonical JSON form plus the
 *     previous row's hash — so any tampering (edit, reorder, delete) breaks
 *     the chain and `verify()` will report the break.
 *   - No secrets are ever logged. `actor` holds only identity (e.g.
 *     "app:12345:install:67890" or "pat:env:SHIPREPORT_GITHUB_TOKEN").
 *   - The payload is caller-provided JSON; callers are responsible for not
 *     putting tokens in it.
 */

export type AuditEvent =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "token_resolved"
  | "token_renewed"
  | "schedule_triggered"
  | "report_written"
  | "config_loaded"
  | "cache_pruned"
  | "members_discovered"
  | "rate_limit_degraded"
  | "extract_checkpointed";

export interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  event: AuditEvent;
  target: string | null;
  payload: unknown;
  prevHash: string;
  hash: string;
}

const ZERO = "0".repeat(64);

export class AuditLog {
  constructor(private readonly state: StateDB) {}

  append(args: {
    actor: string;
    event: AuditEvent;
    target?: string | null;
    payload?: unknown;
  }): AuditRow {
    const at = new Date().toISOString();
    const payload = args.payload ?? {};
    const target = args.target ?? null;
    const prevHash = this.headHash();
    const canonical = canonicalize({
      at,
      actor: args.actor,
      event: args.event,
      target,
      payload,
      prevHash,
    });
    const hash = sha256(canonical);

    // node:sqlite's StatementResultingChanges.lastInsertRowid returns the
    // rowid of the just-inserted row. seq is the AUTOINCREMENT primary
    // key column so it equals lastInsertRowid by definition. Avoiding
    // the SELECT round-trip keeps the hot append path single-shot and
    // sidesteps a (theoretical, but real) UNIQUE-collision race where
    // another writer could in-between match the same hash.
    const result = this.state.db
      .prepare(
        `INSERT INTO audit_log (at, actor, event, target, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at, args.actor, args.event, target, JSON.stringify(payload), prevHash, hash);
    const seq = Number(result.lastInsertRowid);
    return { seq, at, actor: args.actor, event: args.event, target, payload, prevHash, hash };
  }

  headHash(): string {
    const row = this.state.db
      .prepare(`SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1`)
      .get();
    if (!row) return ZERO;
    return expectString(row as Record<string, unknown>, "hash");
  }

  /**
   * Read rows chronologically (seq ASC), optionally from a `since` lower
   * bound. Intended for `audit export`: a downstream verifier needs the
   * chain in order to reconstruct it.
   */
  readForward(since?: string): AuditRow[] {
    const stmt = this.state.db.prepare(
      since
        ? `SELECT seq, at, actor, event, target, payload, prev_hash, hash
           FROM audit_log WHERE at >= ? ORDER BY seq ASC`
        : `SELECT seq, at, actor, event, target, payload, prev_hash, hash
           FROM audit_log ORDER BY seq ASC`,
    );
    const rows = since ? stmt.all(since) : stmt.all();
    return rows.map(parseRawRow).map(rawToRow);
  }

  /** Current chain head {seq, hash}, or null if the log is empty. */
  head(): { seq: number; hash: string } | null {
    const row = this.state.db
      .prepare(`SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`)
      .get();
    if (!row) return null;
    const seq = expectInt(row, "seq");
    const hash = expectString(row, "hash");
    return { seq, hash };
  }

  tail(limit: number, since?: string): AuditRow[] {
    const stmt = this.state.db.prepare(
      since
        ? `SELECT seq, at, actor, event, target, payload, prev_hash, hash
           FROM audit_log WHERE at >= ? ORDER BY seq DESC LIMIT ?`
        : `SELECT seq, at, actor, event, target, payload, prev_hash, hash
           FROM audit_log ORDER BY seq DESC LIMIT ?`,
    );
    const rows = since ? stmt.all(since, limit) : stmt.all(limit);
    return rows.map(parseRawRow).map(rawToRow);
  }

  /** Walk the chain forward and verify every row. */
  verify(): { ok: true; rows: number } | { ok: false; brokeAtSeq: number; reason: string } {
    const rows = this.state.db
      .prepare(
        `SELECT seq, at, actor, event, target, payload, prev_hash, hash
         FROM audit_log ORDER BY seq ASC`,
      )
      .all()
      .map(parseRawRow);
    let expectedPrev = ZERO;
    for (const r of rows) {
      if (r.prev_hash !== expectedPrev) {
        return { ok: false, brokeAtSeq: r.seq, reason: "prev_hash mismatch" };
      }
      const canonical = canonicalize({
        at: r.at,
        actor: r.actor,
        event: r.event as AuditEvent,
        target: r.target,
        payload: JSON.parse(r.payload) as unknown,
        prevHash: r.prev_hash,
      });
      if (sha256(canonical) !== r.hash) {
        return { ok: false, brokeAtSeq: r.seq, reason: "row hash mismatch" };
      }
      expectedPrev = r.hash;
    }
    return { ok: true, rows: rows.length };
  }
}

interface RawRow {
  seq: number;
  at: string;
  actor: string;
  event: string;
  target: string | null;
  payload: string;
  prev_hash: string;
  hash: string;
}

/**
 * Validate and narrow a SQLite-returned row into the audit_log RawRow
 * shape. The runtime check here is what lets the rest of the module
 * stay strictly typed without `any` casts: every column is asserted to
 * be the type the schema requires, and a violation throws loudly rather
 * than silently producing a ghost row.
 */
function parseRawRow(raw: unknown): RawRow {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`audit_log row is not an object: ${String(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  return {
    seq: expectInt(r, "seq"),
    at: expectString(r, "at"),
    actor: expectString(r, "actor"),
    event: expectString(r, "event"),
    target: r["target"] === null ? null : expectString(r, "target"),
    payload: expectString(r, "payload"),
    prev_hash: expectString(r, "prev_hash"),
    hash: expectString(r, "hash"),
  };
}

function expectString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") {
    throw new Error(`audit_log.${key} expected string, got ${typeof v}`);
  }
  return v;
}

function expectInt(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`audit_log.${key} expected integer, got ${typeof v}`);
}

function rawToRow(r: RawRow): AuditRow {
  return {
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    event: r.event as AuditEvent,
    target: r.target,
    payload: JSON.parse(r.payload) as unknown,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Test-only re-exports of the row validators. They are private to this
 * module by design (no production caller in src/ has a reason to invoke
 * them directly), but unit tests need to exercise the throw paths so
 * the per-file 100%-line / 95%-branch SOC2 coverage floor is honoured.
 */
export const __testInternals = { parseRawRow, expectString, expectInt };

/** Deterministic JSON serialization: sorted object keys, no whitespace. */
export function canonicalize(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
}
