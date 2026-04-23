import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuditLog, type AuditEvent } from "../src/audit.js";
import { StateDB } from "../src/state.js";

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
  it("for any non-empty sequence of appends, verify() is ok", async () => {
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
      25,
    );
  });

  it("mutating any single row's payload, target, or at — offline — is detected", async () => {
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
      25,
    );
  });

  it("deleting any single row is detected", async () => {
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
      25,
    );
  });
});
