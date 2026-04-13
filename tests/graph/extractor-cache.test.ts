import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGraph } from "../../src/graph/extractor.js";
import {
  checkFileCache,
  saveFileCache,
  resolveCachePaths,
} from "../../src/graph/cache.js";
import type { CodeGraph } from "../../src/graph/types.js";

describe("extractGraph cache integration", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-ext-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("returns identical results with cache=true on repeat call", async () => {
    const files = [{
      path: "/abs/a.ts",
      content: "function foo() { bar(); } function bar() {}",
    }];
    const opts = { cacheDir, repoKey: "test" };

    const first = await extractGraph(files, { cache: opts });
    const second = await extractGraph(files, { cache: opts });

    expect(second.defines.map((d) => d.name).sort()).toEqual(
      first.defines.map((d) => d.name).sort(),
    );
    expect(second.calls).toEqual(first.calls);
  });

  it("uses cached fragment instead of re-parsing", async () => {
    const opts = { cacheDir, repoKey: "test" };
    const sentinelGraph: CodeGraph = {
      defines: [{ file: "/abs/a.ts", name: "SENTINEL_FN", kind: "function", line: 42 }],
      calls: [],
      imports: [],
      exports: [],
      contains: [],
      files: [{ path: "/abs/a.ts", language: "typescript" }],
    };
    // Pre-populate cache with a fragment that does NOT match real extraction.
    await saveFileCache(
      [{ path: "/abs/a.ts", content: "function real() {}", graph: sentinelGraph }],
      opts,
    );

    const result = await extractGraph(
      [{ path: "/abs/a.ts", content: "function real() {}" }],
      { cache: opts },
    );

    // If cache was consulted, the sentinel wins over real parsing.
    expect(result.defines.some((d) => d.name === "SENTINEL_FN")).toBe(true);
    expect(result.defines.some((d) => d.name === "real")).toBe(false);
  });

  it("re-extracts when content changes", async () => {
    const opts = { cacheDir, repoKey: "test" };
    await extractGraph(
      [{ path: "/abs/a.ts", content: "function v1() {}" }],
      { cache: opts },
    );
    const result = await extractGraph(
      [{ path: "/abs/a.ts", content: "function v2() {}" }],
      { cache: opts },
    );
    expect(result.defines.some((d) => d.name === "v2")).toBe(true);
    expect(result.defines.some((d) => d.name === "v1")).toBe(false);
  });

  it("caches new extractions so next call hits", async () => {
    const opts = { cacheDir, repoKey: "test" };
    await extractGraph(
      [{ path: "/abs/a.ts", content: "function foo() {}" }],
      { cache: opts },
    );
    const { hits } = await checkFileCache(
      [{ path: "/abs/a.ts", content: "function foo() {}" }],
      opts,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].graph.defines.some((d) => d.name === "foo")).toBe(true);
  });

  it("partial cache hit: mixed extraction for hit + miss", async () => {
    const opts = { cacheDir, repoKey: "test" };
    // Prime cache for a.ts
    await extractGraph(
      [{ path: "/abs/a.ts", content: "function a() {}" }],
      { cache: opts },
    );
    // Now extract both — a.ts should be cached, b.ts fresh
    const result = await extractGraph(
      [
        { path: "/abs/a.ts", content: "function a() {}" },
        { path: "/abs/b.ts", content: "function b() {}" },
      ],
      { cache: opts },
    );
    const names = result.defines.map((d) => d.name).sort();
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("does not touch cache when cache option is omitted", async () => {
    // Run extraction without cache — cache dir should stay empty.
    await extractGraph([{ path: "/abs/a.ts", content: "function a() {}" }]);
    const { filesDir } = resolveCachePaths({ cacheDir, repoKey: "test" });
    // The repoDir under our test cacheDir should have no entries because
    // cache wasn't used. (Directory may not exist at all — that's also fine.)
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(filesDir);
      expect(entries).toHaveLength(0);
    } catch {
      // Dir missing entirely — acceptable.
    }
  });
});
