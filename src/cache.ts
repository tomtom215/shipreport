import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CacheEntry {
  etag: string | null;
  body: string;
  fetchedAt: number;
}

/** Opaque snapshot row for the per-(repo, quarter) extract cache. */
export interface ExtractSnapshotRow {
  body: string;
  fetchedAt: number;
}

export class Cache {
  private db: DatabaseSync;
  private ttlMs: number;

  constructor(dbPath: string, ttlDays: number) {
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    this.db = new DatabaseSync(dbPath);
    // WAL: keep readers (e.g. concurrent `audit export` or schedule
    // tick reading the schedule_state side via the audit DB) unblocked
    // by the writer that's currently saving an extract snapshot.
    this.db.exec(`PRAGMA journal_mode=WAL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS http_cache (
        key TEXT PRIMARY KEY,
        etag TEXT,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_cache_fetched ON http_cache(fetched_at);

      CREATE TABLE IF NOT EXISTS extract_snapshots (
        key TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_extract_fetched ON extract_snapshots(fetched_at);

      -- Checkpoints are ephemeral — rows only exist while a pagination is
      -- in progress or stalled by a failure. A completed extract deletes
      -- its own checkpoint; a crashed extract leaves the row so the next
      -- run can resume from the last successful page.
      CREATE TABLE IF NOT EXISTS extract_checkpoints (
        key TEXT PRIMARY KEY,
        cursor TEXT,
        partial_body TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  static async open(dbPath: string, ttlDays: number): Promise<Cache> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    return new Cache(dbPath, ttlDays);
  }

  get(key: string): CacheEntry | null {
    const row = this.db
      .prepare("SELECT etag, body, fetched_at FROM http_cache WHERE key = ?")
      .get(key);
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      etag: r["etag"] === null ? null : expectStr(r, "etag"),
      body: expectStr(r, "body"),
      fetchedAt: expectNum(r, "fetched_at"),
    };
  }

  set(key: string, etag: string | null, body: string): void {
    this.db
      .prepare(
        "INSERT INTO http_cache(key, etag, body, fetched_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, body = excluded.body, fetched_at = excluded.fetched_at",
      )
      .run(key, etag, body, Date.now());
  }

  getExtractSnapshot(key: string): ExtractSnapshotRow | null {
    const row = this.db
      .prepare("SELECT body, fetched_at FROM extract_snapshots WHERE key = ?")
      .get(key);
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return { body: expectStr(r, "body"), fetchedAt: expectNum(r, "fetched_at") };
  }

  setExtractSnapshot(key: string, body: string): void {
    this.db
      .prepare(
        "INSERT INTO extract_snapshots(key, body, fetched_at) VALUES(?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
      )
      .run(key, body, Date.now());
  }

  getCheckpoint(
    key: string,
  ): { cursor: string | null; partialBody: string; updatedAt: number } | null {
    const row = this.db
      .prepare("SELECT cursor, partial_body, updated_at FROM extract_checkpoints WHERE key = ?")
      .get(key);
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      cursor: r["cursor"] === null ? null : expectStr(r, "cursor"),
      partialBody: expectStr(r, "partial_body"),
      updatedAt: expectNum(r, "updated_at"),
    };
  }

  setCheckpoint(key: string, cursor: string | null, partialBody: string): void {
    this.db
      .prepare(
        "INSERT INTO extract_checkpoints(key, cursor, partial_body, updated_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, partial_body = excluded.partial_body, updated_at = excluded.updated_at",
      )
      .run(key, cursor, partialBody, Date.now());
  }

  clearCheckpoint(key: string): void {
    this.db.prepare("DELETE FROM extract_checkpoints WHERE key = ?").run(key);
  }

  isFresh(entry: { fetchedAt: number }): boolean {
    return Date.now() - entry.fetchedAt < this.ttlMs;
  }

  prune(): number {
    const cutoff = Date.now() - this.ttlMs;
    const a = this.db.prepare("DELETE FROM http_cache WHERE fetched_at < ?").run(cutoff);
    const b = this.db
      .prepare("DELETE FROM extract_snapshots WHERE fetched_at < ?")
      .run(cutoff);
    // Checkpoints never go stale on a TTL basis — they're cleaned up on
    // successful extract — but sweep ones older than TTL as a safety net.
    const c = this.db
      .prepare("DELETE FROM extract_checkpoints WHERE updated_at < ?")
      .run(cutoff);
    return Number(a.changes) + Number(b.changes) + Number(c.changes);
  }

  close(): void {
    this.db.close();
  }
}

function expectStr(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") {
    throw new Error(`cache row.${key} expected string, got ${typeof v}`);
  }
  return v;
}

function expectNum(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`cache row.${key} expected number, got ${typeof v}`);
}

/**
 * Test-only re-exports of the row validators. Production code never
 * calls them directly — they run inline as part of every Cache.* read —
 * but the throw paths protect callers from corrupted DB state and need
 * direct exercise. SQLite's TEXT-affinity coercion makes it
 * impractical to provoke them via on-disk corruption alone.
 */
export const __testInternals = { expectStr, expectNum };
