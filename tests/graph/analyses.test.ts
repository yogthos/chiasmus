import { describe, it, expect } from "vitest";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
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
