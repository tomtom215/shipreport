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
  | "schedule_triggered"
  | "report_written"
  | "config_loaded"
  | "cache_pruned";

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

    this.state.db
      .prepare(
        `INSERT INTO audit_log (at, actor, event, target, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at, args.actor, args.event, target, JSON.stringify(payload), prevHash, hash);

    const seq = Number(
      (this.state.db.prepare(`SELECT seq FROM audit_log WHERE hash = ?`).get(hash) as {
        seq: number;
      }).seq,
    );
    return { seq, at, actor: args.actor, event: args.event, target, payload, prevHash, hash };
  }

  headHash(): string {
    const row = this.state.db
      .prepare(`SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1`)
      .get() as { hash: string } | undefined;
    return row?.hash ?? ZERO;
  }

  tail(limit: number, since?: string): AuditRow[] {
    const rows = since
      ? (this.state.db
          .prepare(
            `SELECT seq, at, actor, event, target, payload, prev_hash, hash
             FROM audit_log WHERE at >= ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(since, limit) as RawRow[])
      : (this.state.db
          .prepare(
            `SELECT seq, at, actor, event, target, payload, prev_hash, hash
             FROM audit_log ORDER BY seq DESC LIMIT ?`,
          )
          .all(limit) as RawRow[]);
    return rows.map(rawToRow);
  }

  /** Walk the chain forward and verify every row. */
  verify(): { ok: true; rows: number } | { ok: false; brokeAtSeq: number; reason: string } {
    const rows = this.state.db
      .prepare(
        `SELECT seq, at, actor, event, target, payload, prev_hash, hash
         FROM audit_log ORDER BY seq ASC`,
      )
      .all() as RawRow[];
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

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deterministic JSON serialization: sorted object keys, no whitespace. */
function canonicalize(v: unknown): string {
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
