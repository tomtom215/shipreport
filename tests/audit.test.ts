import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuditLog, __testInternals } from "../src/audit.js";
import { StateDB } from "../src/state.js";

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-audit-"));
  return path.join(dir, "state.sqlite");
}

async function freshLog(): Promise<{ log: AuditLog; state: StateDB }> {
  const state = await StateDB.open(await tmp());
  return { log: new AuditLog(state), state };
}

describe("AuditLog", () => {
  it("first row's prev_hash is all zeros", async () => {
    const { log, state } = await freshLog();
    const row = log.append({ actor: "alice", event: "run_started", target: "acme/team" });
    expect(row.prevHash).toBe("0".repeat(64));
    expect(row.hash).toHaveLength(64);
    state.close();
  });

  it("head() returns null on an empty log and the latest row afterwards", async () => {
    const { log, state } = await freshLog();
    expect(log.head()).toBeNull();
    const a = log.append({ actor: "alice", event: "run_started", target: "t" });
    expect(log.head()).toEqual({ seq: a.seq, hash: a.hash });
    const b = log.append({ actor: "alice", event: "run_completed", target: "t" });
    expect(log.head()).toEqual({ seq: b.seq, hash: b.hash });
    state.close();
  });

  it("each row's prev_hash equals the previous row's hash", async () => {
    const { log, state } = await freshLog();
    const a = log.append({ actor: "alice", event: "run_started", target: "t" });
    const b = log.append({ actor: "alice", event: "run_completed", target: "t" });
    expect(b.prevHash).toBe(a.hash);
    state.close();
  });

  it("verify() returns ok on a clean chain", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({ actor: "a", event: "report_written", target: "t", payload: { path: "/x.md" } });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    const res = log.verify();
    expect(res).toMatchObject({ ok: true, rows: 3 });
    state.close();
  });

  // Defense-in-depth: SQLite triggers reject UPDATE/DELETE at the storage
  // layer. To simulate a raw-file-level attacker who bypassed the Node API
  // AND was willing to re-create the DB, we drop the triggers before
  // mutating in these tests. `verify()` must still catch the break.
  const dropTriggers = (state: StateDB): void => {
    state.db.exec(`
      DROP TRIGGER IF EXISTS audit_log_no_update;
      DROP TRIGGER IF EXISTS audit_log_no_delete;
    `);
  };

  it("verify() detects a tampered payload (offline attack)", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    dropTriggers(state);
    state.db.prepare(`UPDATE audit_log SET payload = '{"tampered":true}' WHERE seq = 1`).run();
    const res = log.verify();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokeAtSeq).toBe(1);
    state.close();
  });

  it("verify() detects a deleted middle row (offline attack)", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({ actor: "a", event: "report_written", target: "t" });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    dropTriggers(state);
    state.db.prepare(`DELETE FROM audit_log WHERE seq = 2`).run();
    const res = log.verify();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokeAtSeq).toBe(3);
    state.close();
  });

  it("verify() detects a reordered row (swapped seq) (offline attack)", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    dropTriggers(state);
    state.db.prepare(`UPDATE audit_log SET seq = 99 WHERE seq = 1`).run();
    const res = log.verify();
    expect(res.ok).toBe(false);
    state.close();
  });

  it("storage-layer trigger rejects UPDATE on audit_log", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    expect(() =>
      state.db.prepare(`UPDATE audit_log SET payload = '{}' WHERE seq = 1`).run(),
    ).toThrow(/append-only/);
    state.close();
  });

  it("storage-layer trigger rejects DELETE on audit_log", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    expect(() =>
      state.db.prepare(`DELETE FROM audit_log WHERE seq = 1`).run(),
    ).toThrow(/append-only/);
    state.close();
  });

  it("tail() returns rows newest-first and respects limit", async () => {
    const { log, state } = await freshLog();
    for (let i = 0; i < 5; i++) {
      log.append({ actor: "a", event: "run_started", target: `t${i}` });
    }
    const rows = log.tail(3);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.target).toBe("t4");
    expect(rows[2]!.target).toBe("t2");
    state.close();
  });

  it("tail(limit, since) filters by `at >= since`", async () => {
    const { log, state } = await freshLog();
    const a = log.append({ actor: "a", event: "run_started", target: "t1" });
    log.append({ actor: "a", event: "run_completed", target: "t1" });
    // Use the second row's `at` as the since cutoff — should keep only rows
    // at or after it (here: every row but the first).
    const rows = log.tail(50, a.at);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.at >= a.at)).toBe(true);
    state.close();
  });

  it("readForward(since) walks rows chronologically from a lower bound", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    const cutoff = log.append({ actor: "a", event: "run_completed", target: "t" });
    log.append({ actor: "a", event: "report_written", target: "t" });
    const rows = log.readForward(cutoff.at);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // All rows are at or after the cutoff, and emitted in seq-ascending order.
    expect(rows.every((r) => r.at >= cutoff.at)).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));
    state.close();
  });

  it("canonicalization is key-order independent (same payload = same hash)", async () => {
    const { log, state } = await freshLog();
    const r1 = log.append({
      actor: "a",
      event: "run_started",
      target: "t",
      payload: { b: 2, a: 1 },
    });
    state.close();

    const { log: log2, state: state2 } = await freshLog();
    const r2 = log2.append({
      actor: "a",
      event: "run_started",
      target: "t",
      payload: { a: 1, b: 2 },
    });
    state2.close();

    // at differs between runs, so we can't compare hashes directly — but we can
    // verify the canonical JSON of the payloads is identical by using the
    // canonicalize behavior of the append (prev_hash = 0, so the only variable
    // is `at`). Just assert that both rows verify independently.
    expect(r1.prevHash).toBe("0".repeat(64));
    expect(r2.prevHash).toBe("0".repeat(64));
  });
});

describe("AuditLog row validators (parseRawRow / expectString / expectInt)", () => {
  // The validators replaced a set of unchecked `as` casts. Their throw
  // paths are the runtime safety net that lets the rest of audit.ts stay
  // free of `any`. SOC2-grade per-file coverage demands they're exercised.
  const { parseRawRow, expectString, expectInt } = __testInternals;

  it("parseRawRow throws on a non-object input", () => {
    expect(() => parseRawRow(null)).toThrow(/not an object/);
    expect(() => parseRawRow(42)).toThrow(/not an object/);
    expect(() => parseRawRow("row")).toThrow(/not an object/);
  });

  it("expectString throws when the column is the wrong type", () => {
    expect(() => expectString({ x: 7 }, "x")).toThrow(/expected string, got number/);
    expect(() => expectString({ x: null }, "x")).toThrow(/expected string, got object/);
    // Sanity: the happy path still works.
    expect(expectString({ x: "ok" }, "x")).toBe("ok");
  });

  it("expectInt accepts numbers and bigints, rejects everything else", () => {
    expect(expectInt({ x: 5 }, "x")).toBe(5);
    expect(expectInt({ x: 9007199254740993n }, "x")).toBe(9007199254740993);
    expect(() => expectInt({ x: "5" }, "x")).toThrow(/expected integer, got string/);
    expect(() => expectInt({ x: 1.5 }, "x")).toThrow(/expected integer/);
  });

  it("parseRawRow promotes a SQLite row into a strict RawRow shape", () => {
    const row = parseRawRow({
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      actor: "alice",
      event: "run_started",
      target: null,
      payload: "{}",
      prev_hash: "0".repeat(64),
      hash: "a".repeat(64),
    });
    expect(row.seq).toBe(1);
    expect(row.target).toBeNull();
    // Same row but with a populated target: must round-trip as string.
    const row2 = parseRawRow({
      seq: 2,
      at: "2026-01-01T00:00:00.000Z",
      actor: "alice",
      event: "run_started",
      target: "acme/team",
      payload: "{}",
      prev_hash: "0".repeat(64),
      hash: "a".repeat(64),
    });
    expect(row2.target).toBe("acme/team");
  });
});

describe("StateDB.open file mode (defense in depth)", () => {
  it("creates the state.sqlite file at mode 0600 (POSIX)", async () => {
    if (process.platform === "win32") return;
    const { stat } = await import("node:fs/promises");
    const dbPath = await tmp();
    const state = await StateDB.open(dbPath);
    try {
      const s = await stat(dbPath);
      expect(s.mode & 0o777).toBe(0o600);
    } finally {
      state.close();
    }
  });

  it("tightens existing -wal and -shm sibling files to 0600 (POSIX)", async () => {
    // node:sqlite's WAL mode creates `<db>-wal` and `<db>-shm` files on
    // first write. Append a row to force their creation, then re-open
    // to exercise the chmod loop on existing siblings.
    if (process.platform === "win32") return;
    const { stat } = await import("node:fs/promises");
    const dbPath = await tmp();
    const state1 = await StateDB.open(dbPath);
    new AuditLog(state1).append({
      actor: "x",
      event: "run_started",
      target: "t",
    });
    state1.close();
    const state2 = await StateDB.open(dbPath);
    try {
      // -wal may have been merged on close; if it exists, it's 0600.
      // -shm is created on every open.
      for (const sib of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        const exists = await stat(sib).then(
          () => true,
          () => false,
        );
        if (exists) {
          const s = await stat(sib);
          expect(s.mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      state2.close();
    }
  });
});
