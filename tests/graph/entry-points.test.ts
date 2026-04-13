import { describe, it, expect } from "vitest";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
import { detectEntryPoints } from "../../src/graph/entry-points.js";
import type { CodeGraph } from "../../src/graph/types.js";

function g(
  defines: Array<{ name: string; file?: string; kind?: "function" | "method" | "class" }>,
  calls: Array<[string, string]>,
  exportNames: string[] = [],
): CodeGraph {
  return {
    defines: defines.map((d) => ({
      file: d.file ?? "t.ts",
      name: d.name,
      kind: d.kind ?? "function",
      line: 1,
    })),
    calls: calls.map(([caller, callee]) => ({ caller, callee })),
    imports: [],
    exports: exportNames.map((name) => ({ file: "t.ts", name })),
    contains: [],
  };
}

describe("detectEntryPoints", () => {
  it("returns [] for empty graph", () => {
    const r = detectEntryPoints({
      defines: [], calls: [], imports: [], exports: [], contains: [],
    });
    expect(r).toEqual([]);
  });

  it("returns zero-in-degree exports", () => {
    // main is exported, calls helper. helper is exported but called by main.
    // Expectation: main is an entry point, helper is not.
    const graph = g(
      [{ name: "main" }, { name: "helper" }],
      [["main", "helper"]],
      ["main", "helper"],
    );
    const r = detectEntryPoints(graph);
    expect(r).toEqual(["main"]);
  });

  it("falls back to all exports when every export has callers", () => {
    // Mutual recursion: a calls b, b calls a. Both exported, both have in-degree 1.
    // Auto-detection must not return an empty set — fall back to all exports.
    const graph = g(
      [{ name: "a" }, { name: "b" }],
      [["a", "b"], ["b", "a"]],
      ["a", "b"],
    );
    const r = detectEntryPoints(graph);
    expect(r.sort()).toEqual(["a", "b"]);
  });

  it("falls back to zero-in-degree functions when there are no exports", () => {
    // No exports → pick functions with no incoming calls as entry points.
    const graph = g(
      [{ name: "start" }, { name: "worker" }],
      [["start", "worker"]],
      [],
    );
    const r = detectEntryPoints(graph);
    expect(r).toEqual(["start"]);
  });

  it("ignores methods (dynamic dispatch)", () => {
    // A method with zero in-degree shouldn't be treated as an entry point —
    // it's dispatched through this.foo() which static analysis misses.
    const graph = g(
      [
        { name: "MyClass", kind: "class" },
        { name: "method", kind: "method" },
        { name: "helper", kind: "function" },
      ],
      [],
      ["method", "helper"],
    );
    const r = detectEntryPoints(graph);
    expect(r).toEqual(["helper"]);
  });

  it("is deterministic (sorted output)", () => {
    const graph = g(
      [{ name: "zeta" }, { name: "alpha" }, { name: "mu" }],
      [],
      ["zeta", "alpha", "mu"],
    );
    const r = detectEntryPoints(graph);
    expect(r).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("runAnalysis: entry-points", () => {
  it("new analysis returns the heuristic entry points", async () => {
    const graph = g(
      [{ name: "main" }, { name: "helper" }],
      [["main", "helper"]],
      ["main", "helper"],
    );
    const r = await runAnalysisFromGraph(graph, { analysis: "entry-points" });
    expect(r.analysis).toBe("entry-points");
    expect(r.result).toEqual(["main"]);
  });

  it("shrinks the entry-point set vs using all exports", async () => {
    // Clojure-style: every defn is exported, but some are utilities called
    // by others. The heuristic removes called-exports — giving downstream
    // analyses a tighter reachability cone.
    const graph = g(
      [{ name: "main" }, { name: "util1" }, { name: "util2" }],
      [["main", "util1"], ["main", "util2"], ["util1", "util2"]],
      ["main", "util1", "util2"],
    );
    const ep = await runAnalysisFromGraph(graph, { analysis: "entry-points" });
    const entries = ep.result as string[];
    // Only main has zero in-degree.
    expect(entries).toEqual(["main"]);
    expect(entries.length).toBeLessThan(graph.exports.length);
  });
});
