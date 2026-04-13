/**
 * Shared helpers for building/iterating an undirected view of the call graph.
 * Used by community detection, hubs, bridges, and surprising-connection
 * scoring — all of which want the same dedup-by-canonical-edge semantics.
 */

import { UndirectedGraph } from "graphology";
import type { CodeGraph } from "./types.js";

/** Every node that appears in defines or as a call endpoint. */
export function collectNodes(graph: CodeGraph): Set<string> {
  const nodes = new Set<string>();
  for (const d of graph.defines) nodes.add(d.name);
  for (const c of graph.calls) { nodes.add(c.caller); nodes.add(c.callee); }
  return nodes;
}

/**
 * Build an undirected graphology graph from the call relation. Self-loops
 * and duplicate edges are dropped — every unique {A,B} pair becomes one edge.
 */
export function buildUndirectedGraph(graph: CodeGraph, nodes?: Set<string>): UndirectedGraph {
  const g = new UndirectedGraph();
  const ns = nodes ?? collectNodes(graph);
  for (const n of ns) g.addNode(n);
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    if (!g.hasNode(c.caller) || !g.hasNode(c.callee)) continue;
    if (!g.hasEdge(c.caller, c.callee)) g.addEdge(c.caller, c.callee);
  }
  return g;
}

/** Iterate each undirected edge exactly once. */
export function forEachUndirectedEdge(
  graph: CodeGraph,
  cb: (a: string, b: string) => void,
): void {
  const seen = new Set<string>();
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const key = c.caller < c.callee ? `${c.caller}|${c.callee}` : `${c.callee}|${c.caller}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cb(c.caller, c.callee);
  }
}

/** Undirected degree: count of distinct neighbors per node. */
export function undirectedDegree(graph: CodeGraph): Map<string, number> {
  const degree = new Map<string, number>();
  forEachUndirectedEdge(graph, (a, b) => {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  });
  return degree;
}
