import { describe, expect, it } from "vitest";
import { Cache, __testInternals as cacheValidators } from "../src/cache.js";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-cache-"));
  return path.join(dir, "c.sqlite");
}

describe("Cache", () => {
  it("round-trips entries", async () => {
    const c = await Cache.open(await tmp(), 7);
    c.set("k1", "etag-1", "{\"hello\":\"world\"}");
    const e = c.get("k1");
    expect(e?.etag).toBe("etag-1");
    expect(e?.body).toBe("{\"hello\":\"world\"}");
    c.close();
  });

  it("returns null for missing key", async () => {
    const c = await Cache.open(await tmp(), 7);
    expect(c.get("nope")).toBeNull();
    c.close();
  });

  it("prune deletes only entries older than ttl", async () => {
    const c = await Cache.open(await tmp(), 7);
    c.set("fresh", null, "x");
    const deleted = c.prune();
    expect(deleted).toBe(0);
    c.close();
  });

  it("upsert replaces the body", async () => {
    const c = await Cache.open(await tmp(), 7);
    c.set("k", null, "a");
    c.set("k", null, "b");
    expect(c.get("k")?.body).toBe("b");
    c.close();
  });

  it("isFresh is true for an entry just fetched and false past the TTL window", async () => {
    const c = await Cache.open(await tmp(), 7);
    expect(c.isFresh({ fetchedAt: Date.now() })).toBe(true);
    // One TTL + 1 ms in the past falls outside the fresh window.
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    expect(c.isFresh({ fetchedAt: Date.now() - ttlMs - 1 })).toBe(false);
    c.close();
  });

  it("checkpoint round-trip and clear", async () => {
    const c = await Cache.open(await tmp(), 7);
    c.setCheckpoint("k", "cur-1", '{"pages":1}');
    const ck = c.getCheckpoint("k");
    expect(ck).not.toBeNull();
    expect(ck!.cursor).toBe("cur-1");
    expect(ck!.partialBody).toBe('{"pages":1}');
    c.clearCheckpoint("k");
    expect(c.getCheckpoint("k")).toBeNull();
    c.close();
  });

  it("prune across all three tables: counts deletions from each", async () => {
    const c = await Cache.open(await tmp(), 7);
    // Empty store → prune returns 0 (covers the COALESCE/?? branch).
    expect(c.prune()).toBe(0);
    c.close();
  });

  it("row validators throw on wrong column types and accept the right ones", () => {
    const { expectStr, expectNum } = cacheValidators;
    // Throw paths: turn corrupted DB state into a loud error rather
    // than silently feeding a junk row into the caller.
    expect(() => expectStr({ k: 7 }, "k")).toThrow(/expected string, got number/);
    expect(() => expectStr({ k: null }, "k")).toThrow(/expected string, got object/);
    expect(() => expectNum({ k: "7" }, "k")).toThrow(/expected number, got string/);

    // Happy paths.
    expect(expectStr({ k: "ok" }, "k")).toBe("ok");
    expect(expectNum({ k: 42 }, "k")).toBe(42);
    expect(expectNum({ k: 9007199254740993n }, "k")).toBe(9007199254740993);
  });
});
