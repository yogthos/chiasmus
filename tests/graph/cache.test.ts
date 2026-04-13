import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileHash,
  checkFileCache,
  saveFileCache,
  clearRepoCache,
  resolveCachePaths,
  evictLRU,
  CACHE_SCHEMA_VERSION,
} from "../../src/graph/cache.js";
import type { CodeGraph } from "../../src/graph/types.js";

function fragment(filePath: string, funcName: string): CodeGraph {
  return {
    defines: [{ file: filePath, name: funcName, kind: "function", line: 1 }],
    calls: [],
    imports: [],
    exports: [],
    contains: [],
  };
}

describe("cache: fileHash", () => {
  it("is deterministic for the same content and path", () => {
    const h1 = fileHash("x=1\n", "/abs/a.ts");
    const h2 = fileHash("x=1\n", "/abs/a.ts");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when content changes", () => {
    const h1 = fileHash("x=1\n", "/abs/a.ts");
    const h2 = fileHash("x=2\n", "/abs/a.ts");
    expect(h1).not.toBe(h2);
  });

  it("changes when path changes", () => {
    // Matches graphify cache.py:20-33 — content || 0x00 || abspath.
    const h1 = fileHash("x=1\n", "/abs/a.ts");
    const h2 = fileHash("x=1\n", "/abs/b.ts");
    expect(h1).not.toBe(h2);
  });

  it("resists boundary collision between content and path", () => {
    // If hashing concatenated content+path without a separator, these would collide.
    const h1 = fileHash("ab", "/c");
    const h2 = fileHash("a", "b/c");
    expect(h1).not.toBe(h2);
  });
});

describe("cache: resolveCachePaths", () => {
  it("returns distinct directories per repo key", () => {
    const a = resolveCachePaths({ cacheDir: "/tmp/x", repoKey: "repo-a" });
    const b = resolveCachePaths({ cacheDir: "/tmp/x", repoKey: "repo-b" });
    expect(a.repoDir).not.toBe(b.repoDir);
    expect(a.filesDir).toContain("repo-a");
    expect(a.manifestPath).toContain("manifest.json");
  });
});

describe("cache: checkFileCache + saveFileCache", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-cache-test-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  const opts = () => ({ cacheDir, repoKey: "test-repo" });

  it("returns all misses on cold cache", async () => {
    const files = [{ path: "/abs/a.ts", content: "function a(){}" }];
    const { hits, misses } = await checkFileCache(files, opts());
    expect(hits).toHaveLength(0);
    expect(misses).toHaveLength(1);
    expect(misses[0].path).toBe("/abs/a.ts");
  });

  it("hits after save on identical content+path", async () => {
    const files = [{ path: "/abs/a.ts", content: "function a(){}" }];
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "function a(){}", graph: fragment("/abs/a.ts", "a") }],
      opts(),
    );
    const { hits, misses } = await checkFileCache(files, opts());
    expect(misses).toHaveLength(0);
    expect(hits).toHaveLength(1);
    expect(hits[0].graph.defines[0].name).toBe("a");
  });

  it("misses after content change", async () => {
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "v1", graph: fragment("/abs/a.ts", "a") }],
      opts(),
    );
    const { hits, misses } = await checkFileCache(
      [{ path: "/abs/a.ts", content: "v2" }],
      opts(),
    );
    expect(hits).toHaveLength(0);
    expect(misses).toHaveLength(1);
  });

  it("misses after schema version bump", async () => {
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "v1", graph: fragment("/abs/a.ts", "a") }],
      opts(),
    );
    // Manually poison the manifest schema version.
    const { manifestPath } = resolveCachePaths(opts());
    const raw = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    manifest.schemaVersion = "0.0.0-stale";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const { hits, misses } = await checkFileCache(
      [{ path: "/abs/a.ts", content: "v1" }],
      opts(),
    );
    expect(hits).toHaveLength(0);
    expect(misses).toHaveLength(1);
  });

  it("leaves no .tmp files after save", async () => {
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "v1", graph: fragment("/abs/a.ts", "a") }],
      opts(),
    );
    const { filesDir } = resolveCachePaths(opts());
    const entries = await readdir(filesDir);
    for (const e of entries) {
      expect(e.endsWith(".tmp")).toBe(false);
    }
  });

  it("manifest carries current schema version", async () => {
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "v1", graph: fragment("/abs/a.ts", "a") }],
      opts(),
    );
    const { manifestPath } = resolveCachePaths(opts());
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    expect(manifest.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
  });

  it("clearRepoCache wipes repo dir but not sibling repos", async () => {
    const optsA = { cacheDir, repoKey: "repo-a" };
    const optsB = { cacheDir, repoKey: "repo-b" };
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "v1", graph: fragment("/abs/a.ts", "a") }],
      optsA,
    );
    await saveFileCache(
      [{ path: "/abs/b.ts", content: "v1", graph: fragment("/abs/b.ts", "b") }],
      optsB,
    );
    await clearRepoCache(optsA);

    const afterA = await checkFileCache([{ path: "/abs/a.ts", content: "v1" }], optsA);
    const afterB = await checkFileCache([{ path: "/abs/b.ts", content: "v1" }], optsB);
    expect(afterA.hits).toHaveLength(0);
    expect(afterB.hits).toHaveLength(1);
  });

  it("mixed file set partially hits", async () => {
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "v1", graph: fragment("/abs/a.ts", "a") }],
      opts(),
    );
    const { hits, misses } = await checkFileCache(
      [
        { path: "/abs/a.ts", content: "v1" },
        { path: "/abs/b.ts", content: "new" },
      ],
      opts(),
    );
    expect(hits).toHaveLength(1);
    expect(misses).toHaveLength(1);
    expect(hits[0].path).toBe("/abs/a.ts");
    expect(misses[0].path).toBe("/abs/b.ts");
  });
});

describe("cache: LRU eviction", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-cache-lru-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  // Build a cache entry whose serialized size is at least `approxBytes` so
  // budget-enforcement tests don't need to care about per-fact overhead.
  function bigFragment(filePath: string, approxBytes: number): CodeGraph {
    const padding = "x".repeat(Math.max(1, approxBytes));
    return {
      defines: [{ file: filePath, name: padding, kind: "function", line: 1 }],
      calls: [],
      imports: [],
      exports: [],
      contains: [],
    };
  }

  it("evicts least-recently-used file entry when over budget", async () => {
    // Budget 12KB and ~4KB entries: 3 fit, a 4th forces eviction of the oldest.
    const opts = { cacheDir, repoKey: "lru-repo", maxBytesPerRepo: 12 * 1024 };

    // Save three ~4KB entries — total would be ~12KB, budget is 8KB so one evicts.
    for (const name of ["a", "b", "c"]) {
      await saveFileCache(
        [{ path: `/abs/${name}.ts`, content: name, graph: bigFragment(`/abs/${name}.ts`, 4096) }],
        opts,
      );
      // Bump atime ordering: sleep 15ms so each save has a distinct timestamp.
      await new Promise((r) => setTimeout(r, 15));
    }

    // Touch 'b' to move it to most-recent position before eviction runs again.
    await checkFileCache([{ path: "/abs/b.ts", content: "b" }], opts);
    await new Promise((r) => setTimeout(r, 15));

    // Trigger a final save that forces eviction.
    await saveFileCache(
      [{ path: "/abs/d.ts", content: "d", graph: bigFragment("/abs/d.ts", 4096) }],
      opts,
    );

    // 'a' was oldest after 'b' was touched, so it should be evicted first.
    const { hits: aHits } = await checkFileCache([{ path: "/abs/a.ts", content: "a" }], opts);
    const { hits: bHits } = await checkFileCache([{ path: "/abs/b.ts", content: "b" }], opts);
    const { hits: dHits } = await checkFileCache([{ path: "/abs/d.ts", content: "d" }], opts);
    expect(aHits).toHaveLength(0);
    expect(bHits).toHaveLength(1);
    expect(dHits).toHaveLength(1);
  });

  it("keeps total repo size under maxBytesPerRepo after evictLRU", async () => {
    const opts = { cacheDir, repoKey: "budget-repo", maxBytesPerRepo: 8 * 1024 };

    for (const name of ["a", "b", "c", "d", "e"]) {
      await saveFileCache(
        [{ path: `/abs/${name}.ts`, content: name, graph: bigFragment(`/abs/${name}.ts`, 4096) }],
        opts,
      );
      await new Promise((r) => setTimeout(r, 10));
    }
    await evictLRU(opts);

    const { filesDir } = resolveCachePaths(opts);
    const entries = await readdir(filesDir);
    let total = 0;
    for (const e of entries) {
      const s = await stat(join(filesDir, e));
      total += s.size;
    }
    expect(total).toBeLessThanOrEqual(opts.maxBytesPerRepo);
  });

  it("does not evict the manifest file", async () => {
    const opts = { cacheDir, repoKey: "manifest-pin", maxBytesPerRepo: 512 };
    // Create enough entries to force aggressive eviction.
    for (let i = 0; i < 5; i++) {
      await saveFileCache(
        [{ path: `/abs/f${i}.ts`, content: String(i), graph: bigFragment(`/abs/f${i}.ts`, 4096) }],
        opts,
      );
    }
    const { manifestPath } = resolveCachePaths(opts);
    // Manifest must still exist and be valid JSON after eviction pressure.
    const raw = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
  });
});

describe("cache: concurrent access safety", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-cache-race-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("parallel saves produce a consistent manifest", async () => {
    const opts = { cacheDir, repoKey: "race-repo" };

    // Fire 10 saves in parallel, each writing a different file.
    const saves = Array.from({ length: 10 }, (_, i) =>
      saveFileCache(
        [{
          path: `/abs/f${i}.ts`,
          content: `v${i}`,
          graph: fragment(`/abs/f${i}.ts`, `fn${i}`),
        }],
        opts,
      ),
    );
    await Promise.all(saves);

    // Every file should be retrievable after the race settles.
    const check = await checkFileCache(
      Array.from({ length: 10 }, (_, i) => ({ path: `/abs/f${i}.ts`, content: `v${i}` })),
      opts,
    );
    expect(check.hits).toHaveLength(10);
    expect(check.misses).toHaveLength(0);

    // Manifest must be parseable JSON (not half-written).
    const { manifestPath } = resolveCachePaths(opts);
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    expect(Object.keys(manifest.entries).length).toBe(10);
  });
});
