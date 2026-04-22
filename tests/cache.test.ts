import { describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
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
});
