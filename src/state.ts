import { mkdir, chmod, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A small shared SQLite DB for non-cache state:
 *   - audit_log (append-only, hash-chained)
 *   - schedule_state (last-run per team)
 *
 * Deliberately separate from the HTTP cache DB so `cache prune` can't touch
 * audit rows, and so a corrupted cache doesn't threaten compliance evidence.
 *
 * Journal mode is WAL: a long extract holding a write lock no longer
 * blocks `audit verify` or `audit export` readers. WAL files (-wal /
 * -shm) live alongside the main DB file; the property test in
 * `tests/audit-property.test.ts` issues `wal_checkpoint(TRUNCATE)` to
 * fold them back into the main file before tampering on disk.
 */
export class StateDB {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async open(dbPath: string): Promise<StateDB> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL;`);
    // Defense-in-depth: the audit log holds chain hashes, run identifiers
    // and event payloads. None of those are strict secrets, but the
    // README's emphasis on compliance evidence and the per-file 0600 key
    // mode justify the same posture for the DB itself. WAL/SHM siblings
    // (-wal / -shm) inherit the file mode SQLite is configured with;
    // we chmod them too if they exist so an `ls -la` from another user
    // doesn't reveal partial writes either.
    /* c8 ignore start — chmod failures (read-only mounts, foreign FS)
       are non-fatal: the DB is functional, the mode is a hardening hint,
       and unit tests on POSIX cover the happy path. */
    try {
      await chmod(dbPath, 0o600);
      for (const sib of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        const exists = await stat(sib).then(
          () => true,
          () => false,
        );
        if (exists) await chmod(sib, 0o600);
      }
    } catch {
      // best-effort
    }
    /* c8 ignore stop */
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        actor       TEXT NOT NULL,
        event       TEXT NOT NULL,
        target      TEXT,
        payload     TEXT NOT NULL,
        prev_hash   TEXT NOT NULL,
        hash        TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at    ON audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);

      -- Defense-in-depth: the Node-level API never mutates existing rows,
      -- but an operator with DB-file access could still UPDATE/DELETE via
      -- raw SQL. These triggers raise at the storage layer so the invariant
      -- holds even if the Node process is bypassed entirely.
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only (UPDATE rejected)');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only (DELETE rejected)');
      END;

      CREATE TABLE IF NOT EXISTS schedule_state (
        team          TEXT PRIMARY KEY,
        last_run_at   TEXT NOT NULL,
        last_status   TEXT NOT NULL,
        last_quarter  TEXT
      );
    `);
    return new StateDB(db);
  }

  close(): void {
    this.db.close();
  }
}
