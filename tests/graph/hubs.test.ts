import { describe, it, expect } from "vitest";
import { detectHubs, detectBridges } from "../../src/graph/insights.js";
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

describe("detectHubs", () => {
  it("returns empty list for empty graph", () => {
    const hubs = detectHubs({ defines: [], calls: [], imports: [], exports: [], contains: [] });
    expect(hubs).toEqual([]);
  });

  it("ranks by total degree (in + out)", () => {
    // 'center' is called by many, calls many — highest degree.
    const edges: Array<[string, string]> = [
      ["a", "center"], ["b", "center"], ["c", "center"],
      ["center", "d"], ["center", "e"],
    ];
    const hubs = detectHubs(g(edges));
    expect(hubs[0].name).toBe("center");
    expect(hubs[0].degree).toBe(5); // 3 in + 2 out
  });

  it("respects topN option", () => {
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 20; i++) edges.push([`caller${i}`, "target"]);
    const hubs = detectHubs(g(edges), { topN: 5 });
    expect(hubs.length).toBeLessThanOrEqual(5);
  });

  it("default topN is 10", () => {
    // Build 15 distinct nodes each with small degree.
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 15; i++) edges.push([`a${i}`, `b${i}`]);
    const hubs = detectHubs(g(edges));
    expect(hubs.length).toBeLessThanOrEqual(10);
  });

  it("ties broken lexically for determinism", () => {
    const edges: Array<[string, string]> = [
      ["x", "zebra"], ["y", "zebra"],  // zebra degree 2
      ["x", "apple"], ["y", "apple"],  // apple degree 2
      ["x", "mango"], ["y", "mango"],  // mango degree 2
    ];
    const hubs = detectHubs(g(edges), { topN: 3 });
    // Among tied-degree nodes, names should appear in lexical order.
    const sameDegree = hubs.filter((h) => h.degree === 2).map((h) => h.name);
    expect([...sameDegree]).toEqual([...sameDegree].sort());
  });
});

describe("detectBridges", () => {
  it("returns empty list for empty graph", () => {
    const bridges = detectBridges({ defines: [], calls: [], imports: [], exports: [], contains: [] });
    expect(bridges).toEqual([]);
  });

  it("identifies bridge node between two cliques", () => {
    // Two triangles connected by a single edge through 'bridge'.
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["a", "c"],
      ["d", "e"], ["e", "f"], ["d", "f"],
      ["c", "bridge"], ["bridge", "d"],
    ];
    const bridges = detectBridges(g(edges));
    const names = bridges.map((b) => b.name);
    // 'bridge' must rank among the top-3 betweenness scores.
    expect(names).toContain("bridge");
  });

  it("returns at most 3 entries (graphify analyze.py:370)", () => {
    // Large graph — there will be many nodes with betweenness > 0; top-3 cap.
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 20; i++) edges.push([`n${i}`, `n${i + 1}`]);
    const bridges = detectBridges(g(edges));
    expect(bridges.length).toBeLessThanOrEqual(3);
  });

  it("excludes nodes with zero betweenness", () => {
    // Two isolated clusters — no node has betweenness > 0.
    const edges: Array<[string, string]> = [
      ["a", "b"],
      ["c", "d"],
    ];
    const bridges = detectBridges(g(edges));
    // Endpoints in simple edges have betweenness = 0 by normalization.
    // Only internal-path nodes get positive scores.
    for (const b of bridges) expect(b.score).toBeGreaterThan(0);
  });
});
