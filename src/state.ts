import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseSync = any;

/**
 * A small shared SQLite DB for non-cache state:
 *   - audit_log (append-only, hash-chained)
 *   - schedule_state (last-run per team)
 *
 * Deliberately separate from the HTTP cache DB so `cache prune` can't touch
 * audit rows, and so a corrupted cache doesn't threaten compliance evidence.
 */
export class StateDB {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async open(dbPath: string): Promise<StateDB> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
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
