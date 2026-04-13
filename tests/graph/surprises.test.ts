import { describe, it, expect } from "vitest";
import { detectSurprisingConnections } from "../../src/graph/insights.js";
import { detectCommunities } from "../../src/graph/community.js";
import type { CodeGraph } from "../../src/graph/types.js";

function g(calls: Array<[string, string]>): CodeGraph {
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

describe("detectSurprisingConnections", () => {
  it("returns empty list for empty graph", () => {
    const r = detectSurprisingConnections({
      defines: [], calls: [], imports: [], exports: [], contains: [],
    });
    expect(r).toEqual([]);
  });

  it("flags cross-community edges", () => {
    // Two cliques connected by a single cross edge.
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["a", "c"],
      ["d", "e"], ["e", "f"], ["d", "f"],
      ["a", "d"], // cross-community
    ];
    const graph = g(edges);
    const communities = detectCommunities(graph);
    const surprises = detectSurprisingConnections(graph, { communities });

    // At least one result should be the cross-community edge.
    const endpoints = surprises.map((s) => [s.source, s.target].sort().join("|"));
    expect(endpoints).toContain(["a", "d"].sort().join("|"));
    // That entry should list 'cross-community' in its reason.
    const xcom = surprises.find(
      (s) => [s.source, s.target].sort().join("|") === ["a", "d"].sort().join("|"),
    );
    expect(xcom?.reason).toMatch(/cross-community/);
  });

  it("peripheral→hub edges earn a +1 bonus", () => {
    // 'hub' has degree 5+. 'leaf' has degree 1. leaf→hub is peripheral→hub.
    const edges: Array<[string, string]> = [
      ["hub", "a"], ["hub", "b"], ["hub", "c"], ["hub", "d"], ["hub", "e"],
      ["leaf", "hub"], // peripheral (leaf) → hub
    ];
    const surprises = detectSurprisingConnections(g(edges));
    const leafHub = surprises.find(
      (s) => [s.source, s.target].sort().join("|") === ["hub", "leaf"].sort().join("|"),
    );
    expect(leafHub).toBeDefined();
    expect(leafHub?.reason).toMatch(/peripheral/);
  });

  it("respects topN option", () => {
    // Build many cross-community edges.
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 10; i++) {
      edges.push([`a${i}`, `a${i + 1}`]);
      edges.push([`b${i}`, `b${i + 1}`]);
    }
    for (let i = 0; i < 10; i++) edges.push([`a${i}`, `b${i}`]);
    const r = detectSurprisingConnections(g(edges), { topN: 3 });
    expect(r.length).toBeLessThanOrEqual(3);
  });

  it("scores descending with deterministic tiebreak", () => {
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["a", "c"],
      ["d", "e"], ["e", "f"], ["d", "f"],
      ["a", "d"], ["c", "f"],
    ];
    const r1 = detectSurprisingConnections(g(edges));
    const r2 = detectSurprisingConnections(g(edges));
    expect(r2).toEqual(r1);
    for (let i = 1; i < r1.length; i++) {
      expect(r1[i - 1].score).toBeGreaterThanOrEqual(r1[i].score);
    }
  });
});
