import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  deleteSnapshot,
} from "../../src/graph/cache.js";
import type { CodeGraph } from "../../src/graph/types.js";

function mkGraph(name: string): CodeGraph {
  return {
    defines: [{ file: "t.ts", name, kind: "function", line: 1 }],
    calls: [],
    imports: [],
    exports: [],
    contains: [],
  };
}

describe("snapshots", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-snapshot-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("saveSnapshot + loadSnapshot round-trips a graph", async () => {
    const opts = { cacheDir, repoKey: "snap-test" };
    const g = mkGraph("foo");
    await saveSnapshot("main", g, opts);
    const loaded = await loadSnapshot("main", opts);
    expect(loaded?.defines[0].name).toBe("foo");
  });

  it("loadSnapshot returns null for missing snapshot", async () => {
    const loaded = await loadSnapshot("nonexistent", { cacheDir, repoKey: "snap-test" });
    expect(loaded).toBeNull();
  });

  it("listSnapshots returns all saved snapshot names", async () => {
    const opts = { cacheDir, repoKey: "snap-test" };
    await saveSnapshot("main", mkGraph("a"), opts);
    await saveSnapshot("feature-x", mkGraph("b"), opts);
    const names = await listSnapshots(opts);
    expect(names.sort()).toEqual(["feature-x", "main"]);
  });

  it("overwrites an existing snapshot with the same name", async () => {
    const opts = { cacheDir, repoKey: "snap-test" };
    await saveSnapshot("main", mkGraph("v1"), opts);
    await saveSnapshot("main", mkGraph("v2"), opts);
    const loaded = await loadSnapshot("main", opts);
    expect(loaded?.defines[0].name).toBe("v2");
  });

  it("deleteSnapshot removes a named snapshot", async () => {
    const opts = { cacheDir, repoKey: "snap-test" };
    await saveSnapshot("tmp", mkGraph("a"), opts);
    await deleteSnapshot("tmp", opts);
    const loaded = await loadSnapshot("tmp", opts);
    expect(loaded).toBeNull();
  });

  it("sanitizes snapshot names to prevent path traversal", async () => {
    const opts = { cacheDir, repoKey: "snap-test" };
    await expect(saveSnapshot("../evil", mkGraph("x"), opts)).rejects.toThrow();
    await expect(saveSnapshot("a/b", mkGraph("x"), opts)).rejects.toThrow();
  });
});
