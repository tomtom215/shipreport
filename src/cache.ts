import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

// Node 22 built-in — no native deps. Loaded via createRequire so bundlers
// (Vite/vitest) don't try to resolve "node:sqlite" at transform time.
const req = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseSync = any;

export interface CacheEntry {
  etag: string | null;
  body: string;
  fetchedAt: number;
}

export class Cache {
  private db: DatabaseSync;
  private ttlMs: number;

  constructor(dbPath: string, ttlDays: number) {
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS http_cache (
        key TEXT PRIMARY KEY,
        etag TEXT,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_cache_fetched ON http_cache(fetched_at);
    `);
  }

  static async open(dbPath: string, ttlDays: number): Promise<Cache> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    return new Cache(dbPath, ttlDays);
  }

  get(key: string): CacheEntry | null {
    const row = this.db
      .prepare("SELECT etag, body, fetched_at FROM http_cache WHERE key = ?")
      .get(key) as { etag: string | null; body: string; fetched_at: number } | undefined;
    if (!row) return null;
    return { etag: row.etag, body: row.body, fetchedAt: row.fetched_at };
  }

  set(key: string, etag: string | null, body: string): void {
    this.db
      .prepare(
        "INSERT INTO http_cache(key, etag, body, fetched_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, body = excluded.body, fetched_at = excluded.fetched_at",
      )
      .run(key, etag, body, Date.now());
  }

  isFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.fetchedAt < this.ttlMs;
  }

  prune(): number {
    const cutoff = Date.now() - this.ttlMs;
    const info = this.db.prepare("DELETE FROM http_cache WHERE fetched_at < ?").run(cutoff);
    return Number(info.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
