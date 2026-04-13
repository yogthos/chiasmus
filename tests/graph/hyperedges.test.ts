import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphToProlog } from "../../src/graph/facts.js";
import { saveSnapshot, loadSnapshot } from "../../src/graph/cache.js";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
import type { CodeGraph, Hyperedge } from "../../src/graph/types.js";

function mkGraph(hyperedges: Hyperedge[] = []): CodeGraph {
  return {
    defines: [
      { file: "t.ts", name: "reader", kind: "function", line: 1 },
      { file: "t.ts", name: "writer", kind: "function", line: 2 },
      { file: "t.ts", name: "flusher", kind: "function", line: 3 },
    ],
    calls: [],
    imports: [],
    exports: [],
    contains: [],
    hyperedges,
  };
}

describe("Hyperedge type + facts emission", () => {
  it("graphToProlog emits nothing hyperedge-related when none present", () => {
    const program = graphToProlog(mkGraph());
    expect(program).not.toMatch(/hyperedge\(/);
    expect(program).not.toMatch(/hyperedge_member\(/);
  });

  it("emits hyperedge/2 and hyperedge_member/2 per entry", () => {
    const hyperedges: Hyperedge[] = [
      { id: "io_stream", label: "IStream implementations", nodes: ["reader", "writer", "flusher"], relation: "implements" },
    ];
    const program = graphToProlog(mkGraph(hyperedges));
    expect(program).toMatch(/hyperedge\(io_stream,\s*implements\)\./);
    expect(program).toMatch(/hyperedge_member\(io_stream,\s*reader\)\./);
    expect(program).toMatch(/hyperedge_member\(io_stream,\s*writer\)\./);
    expect(program).toMatch(/hyperedge_member\(io_stream,\s*flusher\)\./);
  });

  it("escapes ids + relations + members as Prolog atoms", () => {
    const hyperedges: Hyperedge[] = [
      { id: "my.ns/group-1", label: "", nodes: ["my.ns/func-a", "my.ns/func-b"], relation: "shares data" },
    ];
    const program = graphToProlog(mkGraph(hyperedges));
    // Single-quoted escaping for non-simple atoms.
    expect(program).toMatch(/hyperedge\('my\.ns\/group-1',\s*'shares data'\)\./);
    expect(program).toMatch(/hyperedge_member\('my\.ns\/group-1',\s*'my\.ns\/func-a'\)\./);
  });

  it("includes :- dynamic(hyperedge/2) declarations", () => {
    const program = graphToProlog(mkGraph([
      { id: "g", label: "", nodes: ["a"], relation: "r" },
    ]));
    expect(program).toMatch(/:-\s*dynamic\(hyperedge\/2\)\./);
    expect(program).toMatch(/:-\s*dynamic\(hyperedge_member\/2\)\./);
  });
});

describe("Hyperedge round-trip via snapshot", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-hyper-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("saveSnapshot + loadSnapshot preserves hyperedges", async () => {
    const opts = { cacheDir, repoKey: "hyper-test" };
    const hyperedges: Hyperedge[] = [
      { id: "group-a", label: "A", nodes: ["reader", "writer"], relation: "implements", source_file: "t.ts" },
    ];
    const graph = mkGraph(hyperedges);
    await saveSnapshot("main", graph, opts);
    const loaded = await loadSnapshot("main", opts);
    expect(loaded?.hyperedges).toEqual(hyperedges);
  });
});

describe("Hyperedge analyses", () => {
  it("summary includes hyperedge count when present", async () => {
    const hyperedges: Hyperedge[] = [
      { id: "g1", label: "", nodes: ["reader", "writer"], relation: "r" },
      { id: "g2", label: "", nodes: ["writer", "flusher"], relation: "r" },
    ];
    const r = await runAnalysisFromGraph(mkGraph(hyperedges), { analysis: "summary" });
    const result = r.result as { hyperedges?: number };
    expect(result.hyperedges).toBe(2);
  });

  it("summary omits hyperedges key when empty", async () => {
    const r = await runAnalysisFromGraph(mkGraph(), { analysis: "summary" });
    const result = r.result as Record<string, unknown>;
    expect(result.hyperedges).toBeUndefined();
  });
});
