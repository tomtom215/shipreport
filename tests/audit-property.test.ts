import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuditLog, type AuditEvent } from "../src/audit.js";
import { StateDB } from "../src/state.js";

// Property-test budget. The audit chain is THE compliance evidence
// surface; over-investing here is correct. Each iteration opens a fresh
// SQLite DB so wall time scales linearly with run count.
//
// Picked to give ~10× the original 25-run budget while staying within
// vitest's per-test timeout. CI stays under 30 s for the whole file.
const NUM_RUNS_HOT = 250;
const NUM_RUNS_DB_HEAVY = 250;
const NUM_RUNS_PAGE_CORRUPT = 50;
const PROP_TIMEOUT_MS = 60_000;

const EVENTS: readonly AuditEvent[] = [
  "run_started",
  "run_completed",
  "run_failed",
  "token_resolved",
  "schedule_triggered",
  "report_written",
  "config_loaded",
  "cache_pruned",
  "members_discovered",
];

const arbEvent = fc.constantFrom(...EVENTS);
const arbActor = fc.string({ minLength: 1, maxLength: 20 });
const arbTarget = fc.option(fc.string({ maxLength: 40 }), { nil: null });
// Payloads are arbitrary JSON-safe values: objects, arrays, primitives.
// fc.jsonValue keeps depth low; plenty for the property.
const arbPayload = fc.jsonValue({ maxDepth: 3 });
const arbAppend = fc.record({
  actor: arbActor,
  event: arbEvent,
  target: arbTarget,
  payload: arbPayload,
});

async function freshLog(): Promise<{ log: AuditLog; state: StateDB }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-audit-prop-"));
  const state = await StateDB.open(path.join(dir, "state.sqlite"));
  return { log: new AuditLog(state), state };
}

// SQLite open is async; wrap fast-check's sync asserts in an async harness.
async function forAllAsync<T>(
  arb: fc.Arbitrary<T>,
  check: (input: T) => Promise<void>,
  runs: number,
): Promise<void> {
  await fc.assert(
    fc.asyncProperty(arb, async (input) => {
      await check(input);
    }),
    { numRuns: runs },
  );
}

describe("AuditLog property — random appends, random mutation", () => {
  it("for any non-empty sequence of appends, verify() is ok", { timeout: PROP_TIMEOUT_MS }, async () => {
    await forAllAsync(
      fc.array(arbAppend, { minLength: 1, maxLength: 20 }),
      async (appends) => {
        const { log, state } = await freshLog();
        try {
          for (const a of appends) {
            log.append(a);
          }
          const res = log.verify();
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.rows).toBe(appends.length);
        } finally {
          state.close();
        }
      },
      NUM_RUNS_HOT,
    );
  });

  it("mutating any single row's payload, target, or at — offline — is detected", { timeout: PROP_TIMEOUT_MS }, async () => {
    await forAllAsync(
      fc
        .tuple(
          fc.array(arbAppend, { minLength: 2, maxLength: 10 }),
          fc.nat(),
          fc.constantFrom<"payload" | "target" | "at">("payload", "target", "at"),
        ),
        async ([appends, seqPick, field]) => {
        const { log, state } = await freshLog();
        try {
          for (const a of appends) log.append(a);
          const targetSeq = (seqPick % appends.length) + 1;

          // Bypass the triggers: represent an attacker with raw DB access.
          state.db.exec(`
            DROP TRIGGER IF EXISTS audit_log_no_update;
            DROP TRIGGER IF EXISTS audit_log_no_delete;
          `);

          if (field === "payload") {
            state.db
              .prepare(`UPDATE audit_log SET payload = ? WHERE seq = ?`)
              .run('{"tampered":true}', targetSeq);
          } else if (field === "target") {
            state.db
              .prepare(`UPDATE audit_log SET target = ? WHERE seq = ?`)
              .run("--MUTATED--", targetSeq);
          } else {
            state.db
              .prepare(`UPDATE audit_log SET at = ? WHERE seq = ?`)
              .run("1970-01-01T00:00:00.000Z", targetSeq);
          }

          const res = log.verify();
          expect(res.ok).toBe(false);
        } finally {
          state.close();
        }
      },
      NUM_RUNS_DB_HEAVY,
    );
  });

  it("deleting any single row is detected", { timeout: PROP_TIMEOUT_MS }, async () => {
    await forAllAsync(
      fc.tuple(fc.array(arbAppend, { minLength: 2, maxLength: 10 }), fc.nat()),
      async ([appends, seqPick]) => {
        const { log, state } = await freshLog();
        try {
          for (const a of appends) log.append(a);
          const targetSeq = (seqPick % appends.length) + 1;

          state.db.exec(`
            DROP TRIGGER IF EXISTS audit_log_no_update;
            DROP TRIGGER IF EXISTS audit_log_no_delete;
          `);
          state.db.prepare(`DELETE FROM audit_log WHERE seq = ?`).run(targetSeq);

          const res = log.verify();
          // Deleting the last row leaves the remaining chain internally
          // consistent — the verifier can't see past the head. Deleting any
          // row before the head must be detected.
          if (targetSeq < appends.length) {
            expect(res.ok).toBe(false);
          } else {
            // Head removal is only detectable with an external anchor
            // (audit snapshot), which is what Pass 3's signed snapshot
            // provides. The in-DB verify() cannot see it.
            expect(res.ok).toBe(true);
          }
        } finally {
          state.close();
        }
      },
      NUM_RUNS_DB_HEAVY,
    );
  });

  // Belt-and-suspenders: simulate an attacker who has raw filesystem
  // access to the SQLite file (no Node API, no SQL — they hex-edit the
  // page bytes). Because every row's hash is computed over the canonical
  // form of (at, actor, event, target, payload, prevHash), a single-byte
  // flip anywhere in those columns must propagate to a hash mismatch on
  // verify(). Any flip we make that ALSO happens to land outside the
  // hashed columns (e.g. in unused B-tree padding) won't be detected by
  // verify(); for those we accept ok==true and document the limit.
  it("flipping a single byte inside a hashed column on the raw SQLite page is detected", { timeout: PROP_TIMEOUT_MS }, async () => {
    await forAllAsync(
      fc.tuple(
        fc.array(arbAppend, { minLength: 2, maxLength: 8 }),
        // Where to look for the flip target: the row's actor or target value.
        // Both are stored as plain UTF-8 bytes inside the SQLite page.
        fc.constantFrom<"actor" | "target">("actor", "target"),
      ),
      async ([appends, marker]) => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-page-corrupt-"));
        const dbPath = path.join(dir, "state.sqlite");
        const state = await StateDB.open(dbPath);
        try {
          // Stamp every append with a unique marker so we can locate it
          // by byte-search in the on-disk file.
          const markerStr = "SHIPREPORT-TEST-NEEDLE-" + Math.random().toString(36).slice(2);
          for (const a of appends) {
            appendDirect(state, marker === "actor" ? markerStr : a.actor, a.event, marker === "target" ? markerStr : (a.target ?? null));
          }
          // SQLite's WAL mode (default for newer Node) keeps pages in the
          // -wal sidecar; force a checkpoint so the bytes are in the main
          // file before we close.
          state.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
          state.close();

          // Hex-edit the on-disk file. Locate the marker bytes and flip
          // exactly one bit. Re-open and verify().
          const buf = await readFile(dbPath);
          const idx = buf.indexOf(markerStr);
          if (idx < 0) {
            // The marker didn't survive (e.g. SQLite stored it
            // compressed in some future format). Skip this case rather
            // than fail — the property only meaningfully tests pages
            // where the marker was findable.
            return;
          }
          buf[idx] = buf[idx]! ^ 0x01; // flip the lowest bit of the first marker byte
          await writeFile(dbPath, buf);

          const reopened = await StateDB.open(dbPath);
          try {
            const res = new AuditLog(reopened).verify();
            // The flip lands inside a hashed column, so verify() MUST
            // detect the mutation. Any failure here is a real chain
            // weakness, not a test artefact.
            expect(res.ok).toBe(false);
          } finally {
            reopened.close();
          }
        } finally {
          // state.close() already happened above; this is a defensive
          // guard for cases that returned early.
          try {
            state.close();
          } catch {
            /* already closed */
          }
        }
      },
      // Page-corruption runs are the most expensive (open → write → close
      // → read → write → reopen → verify), so we allocate the smaller
      // budget defined above.
      NUM_RUNS_PAGE_CORRUPT,
    );
  });
});

// Direct append helper that doesn't go through the AuditLog API surface —
// keeps the page-corruption test minimal.
function appendDirect(
  state: StateDB,
  actor: string,
  event: AuditEvent,
  target: string | null,
): void {
  new AuditLog(state).append({ actor, event, target, payload: {} });
}
