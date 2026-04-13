import type { CodeGraph, ImportsFact, ExportsFact, Hyperedge } from "./types.js";

export interface GraphDiffEdge {
  source: string;
  target: string;
}

export interface GraphDiffResult {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: GraphDiffEdge[];
  removedEdges: GraphDiffEdge[];
  addedImports?: ImportsFact[];
  removedImports?: ImportsFact[];
  addedExports?: ExportsFact[];
  removedExports?: ExportsFact[];
  addedHyperedges?: Hyperedge[];
  removedHyperedges?: Hyperedge[];
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

function importKey(i: ImportsFact): string {
  return `${i.file}\u0000${i.name}\u0000${i.source}`;
}

function exportKey(e: ExportsFact): string {
  return `${e.file}\u0000${e.name}`;
}

/**
 * Hyperedge identity includes member set + relation — changing membership
 * or relation on the same id produces (remove-old, add-new) pair, which
 * callers doing PR review find more useful than silently tolerating drift.
 */
function hyperedgeKey(h: Hyperedge): string {
  return `${h.id}\u0000${h.relation}\u0000${[...h.nodes].sort().join(",")}`;
}

function diffByKey<T>(
  before: T[],
  after: T[],
  keyFn: (item: T) => string,
): { added: T[]; removed: T[] } {
  const beforeMap = new Map<string, T>();
  for (const item of before) beforeMap.set(keyFn(item), item);
  const afterMap = new Map<string, T>();
  for (const item of after) afterMap.set(keyFn(item), item);
  const added: T[] = [];
  const removed: T[] = [];
  for (const [k, v] of afterMap) if (!beforeMap.has(k)) added.push(v);
  for (const [k, v] of beforeMap) if (!afterMap.has(k)) removed.push(v);
  return { added, removed };
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
 * (source, target) tuple. Imports/exports/hyperedges are diffed on value
 * identity so structural changes (not just call-graph changes) surface.
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

  const imports = diffByKey(before.imports, after.imports, importKey);
  const exports = diffByKey(before.exports, after.exports, exportKey);
  const hyperedges = diffByKey(
    before.hyperedges ?? [],
    after.hyperedges ?? [],
    hyperedgeKey,
  );

  const parts: string[] = [];
  if (addedNodes.length) parts.push(pluralize(addedNodes.length, "new node"));
  if (addedEdges.length) parts.push(pluralize(addedEdges.length, "new edge"));
  if (imports.added.length) parts.push(pluralize(imports.added.length, "new import"));
  if (exports.added.length) parts.push(pluralize(exports.added.length, "new export"));
  if (hyperedges.added.length) parts.push(pluralize(hyperedges.added.length, "new hyperedge"));
  if (removedNodes.length) parts.push(`${pluralize(removedNodes.length, "node")} removed`);
  if (removedEdges.length) parts.push(`${pluralize(removedEdges.length, "edge")} removed`);
  if (imports.removed.length) parts.push(`${pluralize(imports.removed.length, "import")} removed`);
  if (exports.removed.length) parts.push(`${pluralize(exports.removed.length, "export")} removed`);
  if (hyperedges.removed.length) parts.push(`${pluralize(hyperedges.removed.length, "hyperedge")} removed`);
  const summary = parts.length === 0 ? "no changes" : parts.join(", ");

  return {
    addedNodes, removedNodes,
    addedEdges, removedEdges,
    addedImports: imports.added, removedImports: imports.removed,
    addedExports: exports.added, removedExports: exports.removed,
    addedHyperedges: hyperedges.added, removedHyperedges: hyperedges.removed,
    summary,
  };
}
