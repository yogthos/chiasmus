import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingCache } from "../../src/search/embedding-cache.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chiasmus-embcache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EmbeddingCache (R8)", () => {
  it("misses on unknown content, hits after put", () => {
    const cache = new EmbeddingCache({ cachePath: join(dir, "cache.json"), dimension: 3 });
    expect(cache.get("hello")).toBeNull();
    cache.put("hello", [0.1, 0.2, 0.3]);
    expect(cache.get("hello")).toEqual([0.1, 0.2, 0.3]);
  });

  it("content-hash keyed — same content always hits even if stored twice", () => {
    const cache = new EmbeddingCache({ cachePath: join(dir, "cache.json"), dimension: 3 });
    cache.put("hello", [1, 2, 3]);
    cache.put("hello", [4, 5, 6]); // overwrite
    expect(cache.get("hello")).toEqual([4, 5, 6]);
  });

  it("putMany stores each content-vector pair", () => {
    const cache = new EmbeddingCache({ cachePath: join(dir, "cache.json"), dimension: 2 });
    cache.putMany(["a", "b", "c"], [[1, 0], [0, 1], [1, 1]]);
    expect(cache.get("a")).toEqual([1, 0]);
    expect(cache.get("b")).toEqual([0, 1]);
    expect(cache.get("c")).toEqual([1, 1]);
  });

  it("putMany rejects length mismatch", () => {
    const cache = new EmbeddingCache({ cachePath: join(dir, "cache.json"), dimension: 2 });
    expect(() => cache.putMany(["a", "b"], [[1, 0]])).toThrow(/mismatch/i);
  });

  it("partitionMissing separates hits from misses and preserves order", () => {
    const cache = new EmbeddingCache({ cachePath: join(dir, "cache.json"), dimension: 2 });
    cache.put("hit1", [1, 0]);
    cache.put("hit2", [0, 1]);
    const { cached, missing, missingIndexes } = cache.partitionMissing([
      "hit1",
      "miss1",
      "hit2",
      "miss2",
    ]);
    // `cached` is index → vector for the hits
    expect(cached.size).toBe(2);
    expect(cached.get(0)).toEqual([1, 0]);
    expect(cached.get(2)).toEqual([0, 1]);
    // `missing` and `missingIndexes` align
    expect(missing).toEqual(["miss1", "miss2"]);
    expect(missingIndexes).toEqual([1, 3]);
  });

  it("save + load round-trips via disk", async () => {
    const cachePath = join(dir, "cache.json");
    const c1 = new EmbeddingCache({ cachePath, dimension: 2 });
    c1.put("hello", [1, 0]);
    c1.put("world", [0, 1]);
    await c1.save();

    const c2 = new EmbeddingCache({ cachePath, dimension: 2 });
    await c2.load();
    expect(c2.get("hello")).toEqual([1, 0]);
    expect(c2.get("world")).toEqual([0, 1]);
  });

  it("load is a no-op when cache file does not exist", async () => {
    const cache = new EmbeddingCache({ cachePath: join(dir, "nope.json"), dimension: 2 });
    await cache.load();
    expect(cache.get("any")).toBeNull();
  });

  it("load discards entries whose dimension mismatches", async () => {
    const cachePath = join(dir, "cache.json");
    const c1 = new EmbeddingCache({ cachePath, dimension: 2 });
    c1.put("hello", [1, 0]);
    await c1.save();

    const c2 = new EmbeddingCache({ cachePath, dimension: 4 });
    await c2.load();
    expect(c2.get("hello")).toBeNull();
  });
});
