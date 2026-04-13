/**
 * Heuristic entry-point detection.
 *
 * Dead-code analysis needs a set of "starting points" from which reachability
 * is traced. When the caller doesn't supply one, chiasmus falls back to
 * `graph.exports` — but for languages like Clojure that export every `defn`,
 * that set is too permissive and dead-code returns nothing.
 *
 * This heuristic prefers exports with ZERO in-degree: functions that nothing
 * in the analyzed scope calls. If it ran at all, something outside scope
 * (HTTP handler, CLI entry, framework dispatch) must have called it — so
 * it's a genuine entry point. Falls back to all exports when every export
 * has a caller (mutual-recursion case), and further back to all zero-in-degree
 * functions when there are no exports at all.
 *
 * Methods (kind === "method") are excluded — they're typically dispatched
 * dynamically via `this.foo()` / `obj.foo()` which static analysis can't
 * fully track.
 */

import type { CodeGraph } from "./types.js";

export function detectEntryPoints(graph: CodeGraph): string[] {
  const called = new Set<string>();
  for (const c of graph.calls) called.add(c.callee);

  const methodNames = new Set<string>();
  const functionNames = new Set<string>();
  for (const d of graph.defines) {
    if (d.kind === "method") methodNames.add(d.name);
    else if (d.kind === "function") functionNames.add(d.name);
  }

  // Export set with methods removed.
  const exportedFns = graph.exports
    .map((e) => e.name)
    .filter((n) => !methodNames.has(n));

  if (exportedFns.length > 0) {
    const zeroInDegree = exportedFns.filter((n) => !called.has(n));
    if (zeroInDegree.length > 0) return [...new Set(zeroInDegree)].sort();
    // Every export has a caller — fall back to all exports so reachability
    // still has a starting set (mutual-recursion case).
    return [...new Set(exportedFns)].sort();
  }

  // No exports at all — seed from zero-in-degree functions.
  const roots: string[] = [];
  for (const n of functionNames) {
    if (!called.has(n)) roots.push(n);
  }
  return [...new Set(roots)].sort();
}
