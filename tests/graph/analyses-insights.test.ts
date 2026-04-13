import { describe, it, expect } from "vitest";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
import { graphToProlog } from "../../src/graph/facts.js";
import type { CodeGraph } from "../../src/graph/types.js";

function makeGraph(calls: Array<[string, string]>): CodeGraph {
  const names = new Set<string>();
  for (const [a, b] of calls) { names.add(a); names.add(b); }
  return {
    defines: [...names].map((n) => ({ file: "t.ts", name: n, kind: "function", line: 1 })),
    calls: calls.map(([caller, callee]) => ({ caller, callee })),
    imports: [],
    exports: [],
    contains: [],
  };
}

describe("runAnalysis: new insight analyses", () => {
  const graph = makeGraph([
    ["a", "b"], ["b", "c"], ["a", "c"],
    ["d", "e"], ["e", "f"], ["d", "f"],
    ["c", "d"],
  ]);

  it("communities analysis returns community list", async () => {
    const r = await runAnalysisFromGraph(graph, { analysis: "communities" });
    expect(r.analysis).toBe("communities");
    const result = r.result as Array<{ id: number; members: string[]; cohesion: number }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("hubs analysis returns ranked nodes", async () => {
    const r = await runAnalysisFromGraph(graph, { analysis: "hubs" });
    expect(r.analysis).toBe("hubs");
    const result = r.result as Array<{ name: string; degree: number }>;
    expect(result[0].degree).toBeGreaterThanOrEqual(result[result.length - 1].degree);
  });

  it("bridges analysis returns betweenness-ranked nodes", async () => {
    const r = await runAnalysisFromGraph(graph, { analysis: "bridges" });
    expect(r.analysis).toBe("bridges");
    const result = r.result as Array<{ name: string; score: number }>;
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("surprises analysis returns cross-community edges", async () => {
    const r = await runAnalysisFromGraph(graph, { analysis: "surprises" });
    expect(r.analysis).toBe("surprises");
    const result = r.result as Array<{ source: string; target: string; score: number }>;
    // c→d is the cross-community link in this graph.
    const pairs = result.map((s) => [s.source, s.target].sort().join("|"));
    expect(pairs).toContain(["c", "d"].sort().join("|"));
  });
});

describe("graphToProlog: insight facts", () => {
  it("emits community/2, cohesion/2, hub/2, and bridge/2 facts when present", () => {
    const graph = makeGraph([
      ["a", "b"], ["b", "c"], ["a", "c"],
      ["d", "e"], ["e", "f"], ["d", "f"],
      ["c", "d"],
    ]);
    const program = graphToProlog(graph, undefined, { includeInsights: true });
    expect(program).toMatch(/community\(\s*[a-z0-9_']+\s*,\s*\d+\s*\)\./);
    expect(program).toMatch(/cohesion\(\s*\d+\s*,\s*[\d.]+\s*\)\./);
    expect(program).toMatch(/hub\(\s*[a-z0-9_']+\s*,\s*\d+\s*\)\./);
  });

  it("omits insight facts by default (keeps facts dump size predictable)", () => {
    const graph = makeGraph([["a", "b"], ["b", "c"]]);
    const program = graphToProlog(graph);
    expect(program).not.toMatch(/community\(/);
    expect(program).not.toMatch(/hub\(/);
    expect(program).not.toMatch(/bridge\(/);
  });
});
