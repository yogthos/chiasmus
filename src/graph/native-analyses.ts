/**
 * Native graph analyses — O(V+E) implementations that run directly on a
 * CodeGraph without going through Tau Prolog. These exist because Prolog
 * (no tabling, linear-scan method filter) times out on mid-size codebases
 * for the reachability-heavy analyses (cycles, impact, reachability, path,
 * dead-code). The Prolog rule set is still emitted by graphToProlog so the
 * `facts` output remains usable with chiasmus_verify.
 */

import type { CodeGraph } from "./types.js";

/** Index structure built once per graph and reused across analyses. */
interface GraphIndex {
  /** Adjacency: caller → unique callees */
  adj: Map<string, string[]>;
  /** Reverse adjacency: callee → unique callers */
  rev: Map<string, string[]>;
  /** Every name that appears as caller or callee */
  nodes: Set<string>;
  /** Names declared as kind=method anywhere in the graph */
  methods: Set<string>;
  /** Names declared as kind=function anywhere in the graph */
  functions: Set<string>;
}

function buildIndex(graph: CodeGraph): GraphIndex {
  const adj = new Map<string, Set<string>>();
  const rev = new Map<string, Set<string>>();
  const nodes = new Set<string>();

  for (const c of graph.calls) {
    nodes.add(c.caller);
    nodes.add(c.callee);
    if (!adj.has(c.caller)) adj.set(c.caller, new Set());
    adj.get(c.caller)!.add(c.callee);
    if (!rev.has(c.callee)) rev.set(c.callee, new Set());
    rev.get(c.callee)!.add(c.caller);
  }

  const methods = new Set<string>();
  const functions = new Set<string>();
  for (const d of graph.defines) {
    nodes.add(d.name);
    if (d.kind === "method") methods.add(d.name);
    if (d.kind === "function") functions.add(d.name);
  }

  // Materialize sets → arrays for traversal-friendly access.
  const adjArr = new Map<string, string[]>();
  for (const [k, v] of adj) adjArr.set(k, Array.from(v));
  const revArr = new Map<string, string[]>();
  for (const [k, v] of rev) revArr.set(k, Array.from(v));

  return { adj: adjArr, rev: revArr, nodes, methods, functions };
}

/**
 * Cycle detection via Tarjan's Strongly Connected Components algorithm.
 * Contract matches the Prolog `func_reaches(X, X)` query: return every
 * node that participates in a function-level cycle. Methods are excluded
 * because unqualified method names collide across classes in the extractor,
 * producing phantom cycles. An edge (A, B) is "function-level" only if
 * neither A nor B is kind=method.
 */
export function cycles(graph: CodeGraph): string[] {
  const idx = buildIndex(graph);

  // Function-filtered adjacency: drop edges where either endpoint is a method.
  const funcAdj = new Map<string, string[]>();
  const funcNodes = new Set<string>();
  for (const [u, vs] of idx.adj) {
    if (idx.methods.has(u)) continue;
    const kept: string[] = [];
    for (const v of vs) {
      if (!idx.methods.has(v)) kept.push(v);
    }
    if (kept.length > 0) {
      funcAdj.set(u, kept);
      funcNodes.add(u);
      for (const v of kept) funcNodes.add(v);
    }
  }

  // Iterative Tarjan's — recursion would stack-overflow on deep chains.
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Set<string>();

  // Work frame for iterative DFS:
  //   v: node being visited
  //   it: index into its successor list
  //   succs: snapshot of successors at visit time
  interface Frame {
    v: string;
    it: number;
    succs: string[];
  }

  for (const start of funcNodes) {
    if (indices.has(start)) continue;

    const work: Frame[] = [{ v: start, it: 0, succs: funcAdj.get(start) ?? [] }];
    indices.set(start, index);
    lowlink.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.it < frame.succs.length) {
        const w = frame.succs[frame.it++];
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlink.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, it: 0, succs: funcAdj.get(w) ?? [] });
        } else if (onStack.has(w)) {
          // Successor is on stack → back-edge. Lower our lowlink.
          const cur = lowlink.get(frame.v)!;
          const wi = indices.get(w)!;
          if (wi < cur) lowlink.set(frame.v, wi);
        }
      } else {
        // Finished visiting successors. If we are an SCC root, pop the SCC.
        if (lowlink.get(frame.v) === indices.get(frame.v)) {
          const scc: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === frame.v) break;
          }
          // SCC is a cycle if size > 1, or size == 1 with a self-loop.
          if (scc.length > 1) {
            for (const n of scc) result.add(n);
          } else {
            const solo = scc[0];
            const outs = funcAdj.get(solo);
            if (outs && outs.includes(solo)) result.add(solo);
          }
        }
        work.pop();
        // Propagate lowlink to parent.
        if (work.length > 0) {
          const parent = work[work.length - 1];
          const parentLow = lowlink.get(parent.v)!;
          const childLow = lowlink.get(frame.v)!;
          if (childLow < parentLow) lowlink.set(parent.v, childLow);
        }
      }
    }
  }

  return Array.from(result);
}

/** BFS from `source` collecting every reachable node along `calls` edges. */
function bfsForward(adj: Map<string, string[]>, source: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [source];
  seen.add(source);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const outs = adj.get(u);
    if (!outs) continue;
    for (const v of outs) {
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

/** Is `to` reachable from `from` through any call chain? */
export function reachability(graph: CodeGraph, from: string, to: string): boolean {
  if (from === to) {
    // Prolog rule: reaches(A,B) holds only via at least one calls step.
    // So a → a is true only if there's a self-loop.
    const idx = buildIndex(graph);
    const outs = idx.adj.get(from);
    return !!outs && outs.includes(to);
  }
  const idx = buildIndex(graph);
  if (!idx.nodes.has(from)) return false;
  const reached = bfsForward(idx.adj, from);
  return reached.has(to);
}

/**
 * Shortest call chain from `from` to `to`. Returned as a Prolog-style list
 * string `[a,b,c]` so the result shape matches the old formatter (which
 * forwarded the Path binding as a string).
 */
export function path(graph: CodeGraph, from: string, to: string): string[] {
  const idx = buildIndex(graph);
  if (!idx.nodes.has(from)) return [];

  const parent = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  let head = 0;
  let found = false;
  while (head < queue.length) {
    const u = queue[head++];
    const outs = idx.adj.get(u);
    if (!outs) continue;
    for (const v of outs) {
      if (seen.has(v)) continue;
      seen.add(v);
      parent.set(v, u);
      if (v === to) {
        found = true;
        head = queue.length; // break outer
        break;
      }
      queue.push(v);
    }
  }
  if (!found) return [];

  const chain: string[] = [];
  let cur: string | undefined = to;
  while (cur !== undefined) {
    chain.push(cur);
    cur = parent.get(cur);
  }
  chain.reverse();
  // Format as Prolog list literal to match the shape emitted by the old
  // string-based path binding.
  return [formatPrologList(chain)];
}

function formatPrologList(names: string[]): string {
  return `[${names.map(quoteIfNeeded).join(",")}]`;
}

function quoteIfNeeded(s: string): string {
  if (/^[a-z][a-zA-Z0-9_]*$/.test(s)) return s;
  // Match the escaping that escapeAtom in facts.ts applies.
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0");
  return `'${escaped}'`;
}

/**
 * Transitive callers of `target` — every node that can reach `target`
 * through any chain of calls. This is the impact analysis: what breaks if
 * `target` changes.
 */
export function impact(graph: CodeGraph, target: string): string[] {
  const idx = buildIndex(graph);
  if (!idx.nodes.has(target)) return [];
  const reached = bfsForward(idx.rev, target);
  reached.delete(target); // Prolog reaches(X, target) excludes the target itself.
  return Array.from(reached);
}

/**
 * Dead functions: defined as kind=function, called by nobody, not an entry
 * point. Methods are intentionally excluded (dynamic dispatch — the static
 * graph can't tell whether a method is live).
 */
export function deadCode(graph: CodeGraph, entryPoints?: string[]): string[] {
  const called = new Set<string>();
  for (const c of graph.calls) called.add(c.callee);

  const entries = new Set<string>();
  if (entryPoints && entryPoints.length > 0) {
    for (const ep of entryPoints) entries.add(ep);
  } else {
    for (const e of graph.exports) entries.add(e.name);
  }

  const dead: string[] = [];
  const seen = new Set<string>();
  for (const d of graph.defines) {
    if (d.kind !== "function") continue;
    if (seen.has(d.name)) continue;
    if (called.has(d.name)) continue;
    if (entries.has(d.name)) continue;
    seen.add(d.name);
    dead.push(d.name);
  }
  return dead;
}

/** Direct callers of `target` — de-duplicated. */
export function callers(graph: CodeGraph, target: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of graph.calls) {
    if (c.callee === target && !seen.has(c.caller)) {
      seen.add(c.caller);
      out.push(c.caller);
    }
  }
  return out;
}

/** Direct callees of `source` — de-duplicated. */
export function callees(graph: CodeGraph, source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of graph.calls) {
    if (c.caller === source && !seen.has(c.callee)) {
      seen.add(c.callee);
      out.push(c.callee);
    }
  }
  return out;
}
