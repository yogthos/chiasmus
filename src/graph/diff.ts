import type { CodeGraph } from "./types.js";

export interface GraphDiffEdge {
  source: string;
  target: string;
}

export interface GraphDiffResult {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: GraphDiffEdge[];
  removedEdges: GraphDiffEdge[];
  summary: string;
}

function collectNodes(graph: CodeGraph): Set<string> {
  const nodes = new Set<string>();
  for (const d of graph.defines) nodes.add(d.name);
  for (const c of graph.calls) { nodes.add(c.caller); nodes.add(c.callee); }
  return nodes;
}

function edgeKey(src: string, tgt: string): string {
  return `${src}\u0000${tgt}`;
}

function collectEdgeKeys(graph: CodeGraph): Set<string> {
  const set = new Set<string>();
  for (const c of graph.calls) set.add(edgeKey(c.caller, c.callee));
  return set;
}

function pluralize(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/**
 * Diff two graphs. Node identity is the name; edge identity is the
 * (source, target) tuple. Changes to edge metadata with the same endpoints
 * produce no diff — intentional, keeps the output actionable.
 */
export function graphDiff(before: CodeGraph, after: CodeGraph): GraphDiffResult {
  const beforeNodes = collectNodes(before);
  const afterNodes = collectNodes(after);

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  for (const n of afterNodes) if (!beforeNodes.has(n)) addedNodes.push(n);
  for (const n of beforeNodes) if (!afterNodes.has(n)) removedNodes.push(n);
  addedNodes.sort();
  removedNodes.sort();

  const beforeEdges = collectEdgeKeys(before);
  const afterEdges = collectEdgeKeys(after);

  const addedEdges: GraphDiffEdge[] = [];
  const removedEdges: GraphDiffEdge[] = [];
  for (const k of afterEdges) {
    if (!beforeEdges.has(k)) {
      const [source, target] = k.split("\u0000");
      addedEdges.push({ source, target });
    }
  }
  for (const k of beforeEdges) {
    if (!afterEdges.has(k)) {
      const [source, target] = k.split("\u0000");
      removedEdges.push({ source, target });
    }
  }
  addedEdges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  removedEdges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  const parts: string[] = [];
  if (addedNodes.length) parts.push(pluralize(addedNodes.length, "new node"));
  if (addedEdges.length) parts.push(pluralize(addedEdges.length, "new edge"));
  if (removedNodes.length) parts.push(`${pluralize(removedNodes.length, "node")} removed`);
  if (removedEdges.length) parts.push(`${pluralize(removedEdges.length, "edge")} removed`);
  const summary = parts.length === 0 ? "no changes" : parts.join(", ");

  return { addedNodes, removedNodes, addedEdges, removedEdges, summary };
}
