/**
 * Shared helpers for building/iterating an undirected view of the call graph.
 * Used by community detection, hubs, bridges, and surprising-connection
 * scoring — all of which want the same dedup-by-canonical-edge semantics.
 */

import { UndirectedGraph } from "graphology";
import type { CodeGraph } from "./types.js";

/**
 * Separators languages use between a namespace and a name: `/` for Clojure
 * (`my.ns/fn`), `:` for Common Lisp (`my-package:fn`), `.` for Go
 * (`internal/store.Type.Method`).
 */
const NAMESPACE_SEPARATORS = ["/", ":", "."] as const;

/**
 * Resolve a user-supplied name to every matching node in the graph.
 *
 * Languages that emit namespace-qualified names store defines as `my.ns/fn`
 * or `my-package:fn`, but a user asking for `callers` of `fn` means it
 * regardless of namespace. We match:
 *   1. a bare name: exact, plus any `<ns>/name`, `<package>:name` or
 *      `<pkg>.Type.name` suffix — `from-input-stream` gets every
 *      `toda.hash/from-input-stream`, `Get` every Go `*.Get` method.
 *   2. a dotted name (Go): exact, plus any node ending in `.name` or `/name`,
 *      so `Store.Get` and `snapshot.Store.Get` find `internal/snapshot.Store.Get`.
 *
 * A name containing `/` or `:` is treated as fully qualified and only
 * matched exactly. Returns an empty array when nothing matches, so callers
 * can short-circuit.
 */
export function resolveSymbolNames(graph: CodeGraph, name: string): string[] {
  const allNames = collectNodes(graph);
  const exact = allNames.has(name);
  if (name.includes("/") || name.includes(":")) return exact ? [name] : [];
  const suffixes = (name.includes(".") ? ["/", "."] : NAMESPACE_SEPARATORS).map((sep) => `${sep}${name}`);
  const matches: string[] = exact ? [name] : [];
  for (const n of allNames) {
    if (n !== name && suffixes.some((suffix) => n.endsWith(suffix))) matches.push(n);
  }
  return matches;
}

/** Collapse whitespace so multi-line signatures stay one line. */
export function collapseSignature(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Every node that appears in defines or as a call endpoint. */
export function collectNodes(graph: CodeGraph): Set<string> {
  const nodes = new Set<string>();
  for (const d of graph.defines) nodes.add(d.name);
  for (const c of graph.calls) { nodes.add(c.caller); nodes.add(c.callee); }
  return nodes;
}

/**
 * A graphology graph whose node `#i` stands for `names[i]`. graphology and
 * its algorithms keep adjacency and results in plain objects keyed by node
 * key, so a name like `toString`, `constructor` or `__proto__` used as a key
 * collides with Object.prototype (addEdge throws "an edge linking ... already
 * exists"). The keys are not bare indices because plain objects enumerate
 * integer-like keys in numeric order: that would reorder every node's
 * neighbors and shift Louvain and Brandes results away from name-keyed ones.
 */
export interface UndirectedView {
  graph: UndirectedGraph;
  names: string[];
}

/**
 * Build an undirected graphology graph from the call relation. Self-loops
 * and duplicate edges are dropped — every unique {A,B} pair becomes one edge.
 */
export function buildUndirectedGraph(graph: CodeGraph, nodes?: Set<string>): UndirectedView {
  const g = new UndirectedGraph();
  const names = [...(nodes ?? collectNodes(graph))];
  const keys = new Map<string, string>();
  names.forEach((n, i) => {
    keys.set(n, `#${i}`);
    g.addNode(`#${i}`);
  });
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const a = keys.get(c.caller);
    const b = keys.get(c.callee);
    if (a === undefined || b === undefined) continue;
    if (!g.hasEdge(a, b)) g.addEdge(a, b);
  }
  return { graph: g, names };
}

/** Re-key a graphology per-node result from node key to node name. */
export function entriesByName<T>(view: UndirectedView, result: Record<string, T>): Array<[string, T]> {
  return Object.entries(result).map(([key, value]) => [view.names[Number(key.slice(1))], value]);
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
