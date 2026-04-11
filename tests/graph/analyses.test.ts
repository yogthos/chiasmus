import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalysis, runAnalysisFromGraph } from "../../src/graph/analyses.js";
import type { CodeGraph } from "../../src/graph/types.js";

function makeGraph(overrides: Partial<CodeGraph> = {}): CodeGraph {
  return {
    defines: overrides.defines ?? [],
    calls: overrides.calls ?? [],
    imports: overrides.imports ?? [],
    exports: overrides.exports ?? [],
    contains: overrides.contains ?? [],
  };
}

describe("runAnalysisFromGraph", () => {
  it("callers returns correct callers", async () => {
    const graph = makeGraph({
      defines: [
        { file: "t.ts", name: "a", kind: "function", line: 1 },
        { file: "t.ts", name: "b", kind: "function", line: 2 },
        { file: "t.ts", name: "c", kind: "function", line: 3 },
      ],
      calls: [
        { caller: "a", callee: "b" },
        { caller: "c", callee: "b" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "callers", target: "b" });
    expect(r.analysis).toBe("callers");
    const callers = r.result as string[];
    expect(callers).toContain("a");
    expect(callers).toContain("c");
  });

  it("callees returns correct callees", async () => {
    const graph = makeGraph({
      defines: [
        { file: "t.ts", name: "a", kind: "function", line: 1 },
        { file: "t.ts", name: "b", kind: "function", line: 2 },
        { file: "t.ts", name: "c", kind: "function", line: 3 },
      ],
      calls: [
        { caller: "a", callee: "b" },
        { caller: "a", callee: "c" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "callees", target: "a" });
    const callees = r.result as string[];
    expect(callees).toContain("b");
    expect(callees).toContain("c");
  });

  it("reachability returns true for transitive path", async () => {
    const graph = makeGraph({
      calls: [
        { caller: "a", callee: "b" },
        { caller: "b", callee: "c" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "reachability", from: "a", to: "c" });
    expect((r.result as any).reachable).toBe(true);
  });

  it("reachability returns false for unconnected nodes", async () => {
    const graph = makeGraph({
      calls: [
        { caller: "a", callee: "b" },
        { caller: "c", callee: "d" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "reachability", from: "a", to: "d" });
    expect((r.result as any).reachable).toBe(false);
  });

  it("dead-code finds unreachable functions", async () => {
    const graph = makeGraph({
      defines: [
        { file: "t.ts", name: "main", kind: "function", line: 1 },
        { file: "t.ts", name: "used", kind: "function", line: 5 },
        { file: "t.ts", name: "unused", kind: "function", line: 10 },
      ],
      calls: [{ caller: "main", callee: "used" }],
      exports: [{ file: "t.ts", name: "main" }],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "dead-code" });
    const dead = r.result as string[];
    expect(dead).toContain("unused");
    expect(dead).not.toContain("main");
    expect(dead).not.toContain("used");
  });

  it("cycles detects circular call dependencies", async () => {
    const graph = makeGraph({
      calls: [
        { caller: "a", callee: "b" },
        { caller: "b", callee: "c" },
        { caller: "c", callee: "a" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "cycles" });
    const cycleNodes = r.result as string[];
    expect(cycleNodes).toContain("a");
    expect(cycleNodes).toContain("b");
    expect(cycleNodes).toContain("c");
  });

  it("cycles ignores phantom self-loops through method name collisions", async () => {
    // Regression: the tree-sitter extractor collapses `obj.method()` to just
    // `method`, so an unrelated function that calls `session.solve()` appears
    // to share a node with `Engine.solve()` — which can call back through
    // `correctionLoop` and create a phantom cycle. Restricting the cycles
    // query to edges where neither endpoint is a method kills this noise.
    const graph = makeGraph({
      defines: [
        { file: "loop.ts", name: "correctionLoop", kind: "function", line: 1 },
        { file: "session.ts", name: "solve", kind: "method", line: 10 },
        { file: "engine.ts", name: "solve", kind: "method", line: 20 },
      ],
      calls: [
        // correctionLoop → session.solve (collapsed to "solve")
        { caller: "correctionLoop", callee: "solve" },
        // engine.solve → correctionLoop (real call)
        { caller: "solve", callee: "correctionLoop" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "cycles" });
    const cycleNodes = r.result as string[];
    expect(cycleNodes).not.toContain("correctionLoop");
    expect(cycleNodes).not.toContain("solve");
  });

  it("cycles still detects real cycles that go through functions only", async () => {
    const graph = makeGraph({
      defines: [
        { file: "t.ts", name: "foo", kind: "function", line: 1 },
        { file: "t.ts", name: "bar", kind: "function", line: 2 },
      ],
      calls: [
        { caller: "foo", callee: "bar" },
        { caller: "bar", callee: "foo" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "cycles" });
    const cycleNodes = r.result as string[];
    expect(cycleNodes).toContain("foo");
    expect(cycleNodes).toContain("bar");
  });

  it("cycles ignores a cycle whose intermediate hop is a method", async () => {
    const graph = makeGraph({
      defines: [
        { file: "t.ts", name: "a", kind: "function", line: 1 },
        { file: "t.ts", name: "m", kind: "method", line: 2 },
        { file: "t.ts", name: "b", kind: "function", line: 3 },
      ],
      calls: [
        { caller: "a", callee: "m" },
        { caller: "m", callee: "b" },
        { caller: "b", callee: "a" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "cycles" });
    const cycleNodes = r.result as string[];
    // Cycle passes through `m` which is a method — excluded
    expect(cycleNodes).not.toContain("a");
    expect(cycleNodes).not.toContain("m");
    expect(cycleNodes).not.toContain("b");
  });

  it("path returns call chain", async () => {
    const graph = makeGraph({
      calls: [
        { caller: "a", callee: "b" },
        { caller: "b", callee: "c" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "path", from: "a", to: "c" });
    const paths = (r.result as any).paths;
    expect(paths.length).toBeGreaterThan(0);
    // The path should contain a, b, c in some form
    const pathStr = JSON.stringify(paths[0]);
    expect(pathStr).toContain("a");
    expect(pathStr).toContain("c");
  });

  it("impact returns all transitive callers", async () => {
    const graph = makeGraph({
      calls: [
        { caller: "main", callee: "handler" },
        { caller: "handler", callee: "validate" },
        { caller: "validate", callee: "query" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "impact", target: "query" });
    const affected = r.result as string[];
    expect(affected).toContain("validate");
    expect(affected).toContain("handler");
    expect(affected).toContain("main");
  });

  it("impact preserves target when a self-loop exists (matches reaches/2 semantics)", async () => {
    const graph = makeGraph({
      calls: [
        { caller: "outer", callee: "rec" },
        { caller: "rec", callee: "rec" }, // self-loop
      ],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "impact", target: "rec" });
    const affected = r.result as string[];
    expect(affected).toContain("outer");
    expect(affected).toContain("rec");
  });

  it("impact strips target when there is no self-loop", async () => {
    const graph = makeGraph({
      calls: [{ caller: "outer", callee: "leaf" }],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "impact", target: "leaf" });
    const affected = r.result as string[];
    expect(affected).toContain("outer");
    expect(affected).not.toContain("leaf");
  });

  it("path returns [f, f] for a self-loop (not empty)", async () => {
    const graph = makeGraph({
      calls: [{ caller: "rec", callee: "rec" }],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "path", from: "rec", to: "rec" });
    const paths = (r.result as any).paths as string[];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toBe("[rec,rec]");
  });

  it("path returns empty when from === to and there is no self-loop", async () => {
    const graph = makeGraph({
      calls: [{ caller: "a", callee: "b" }],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "path", from: "a", to: "a" });
    const paths = (r.result as any).paths as string[];
    expect(paths).toEqual([]);
  });

  it("unqualified target resolves to namespace-qualified node (Clojure compat)", async () => {
    const graph = makeGraph({
      defines: [
        { file: "hash.clj", name: "toda.hash/from-input-stream", kind: "function", line: 1 },
      ],
      calls: [
        { caller: "toda.packet/load", callee: "toda.hash/from-input-stream" },
      ],
    });

    // User passes the bare name `from-input-stream` — must find the qualified match.
    const r = await runAnalysisFromGraph(graph, {
      analysis: "callers",
      target: "from-input-stream",
    });
    const callers = r.result as string[];
    expect(callers).toContain("toda.packet/load");
  });

  it("facts returns valid Prolog string", async () => {
    const graph = makeGraph({
      defines: [{ file: "t.ts", name: "a", kind: "function", line: 1 }],
      calls: [{ caller: "a", callee: "b" }],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "facts" });
    const program = r.result as string;
    expect(program).toContain("defines(");
    expect(program).toContain("calls(");
    expect(program).toContain("reaches(");
  });

  it("summary returns correct counts", async () => {
    const graph = makeGraph({
      defines: [
        { file: "a.ts", name: "foo", kind: "function", line: 1 },
        { file: "b.ts", name: "bar", kind: "function", line: 1 },
        { file: "b.ts", name: "Svc", kind: "class", line: 5 },
      ],
      calls: [{ caller: "foo", callee: "bar" }],
      imports: [{ file: "a.ts", name: "bar", source: "./b" }],
      exports: [{ file: "a.ts", name: "foo" }],
    });

    const r = await runAnalysisFromGraph(graph, { analysis: "summary" });
    const summary = r.result as any;
    expect(summary.files).toBe(2);
    expect(summary.functions).toBe(2);
    expect(summary.classes).toBe(1);
    expect(summary.callEdges).toBe(1);
  });

  it("returns error for missing target parameter", async () => {
    const graph = makeGraph();
    const r = await runAnalysisFromGraph(graph, { analysis: "callers" });
    expect((r.result as any).error).toMatch(/missing/i);
  });
});

describe("runAnalysis file I/O surface", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-analysis-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads a real file and returns a non-empty summary", async () => {
    const filePath = join(tempDir, "sample.ts");
    await writeFile(filePath, "export function foo() { return bar(); }\nfunction bar() { return 1; }\n");

    const r = await runAnalysis([filePath], { analysis: "summary" });
    const summary = r.result as any;
    expect(summary.functions).toBeGreaterThan(0);
    expect(r.warnings ?? []).toEqual([]);
  });

  it("reports a warning when a requested file is unreadable", async () => {
    const missing = join(tempDir, "does-not-exist.ts");
    const filePath = join(tempDir, "real.ts");
    await writeFile(filePath, "function ok() {}\n");

    const r = await runAnalysis([filePath, missing], { analysis: "summary" });
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.length).toBe(1);
    expect(r.warnings![0]).toContain("does-not-exist.ts");
  });

  it("returns an error result when every requested file is unreadable", async () => {
    const bogus = [
      join(tempDir, "nope-1.ts"),
      join(tempDir, "nope-2.ts"),
    ];
    const r = await runAnalysis(bogus, { analysis: "summary" });
    expect((r.result as any).error).toMatch(/no files/i);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.length).toBe(2);
  });

  it("an empty filePaths list is not an error — returns empty summary with no warnings", async () => {
    const r = await runAnalysis([], { analysis: "summary" });
    const summary = r.result as any;
    expect(summary.functions).toBe(0);
    expect(r.warnings ?? []).toEqual([]);
  });
});
