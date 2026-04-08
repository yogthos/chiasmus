import type { CodeGraph } from "./types.js";

/** Escape a string for use as a Prolog atom (single-quoted if needed) */
export function escapeAtom(s: string): string {
  // Simple atoms: lowercase start, only letters/digits/underscore
  if (/^[a-z][a-z0-9_]*$/.test(s)) {
    return s;
  }
  // Quote and escape internal single quotes
  return `'${s.replace(/'/g, "''")}'`;
}

/** Built-in Prolog rules for graph analysis (cycle-safe) */
export const BUILTIN_RULES = `
% List membership (not built-in in Tau Prolog without lists module)
member(X, [X|_]).
member(X, [_|T]) :- member(X, T).

% Cycle-safe reachability via visited list
reaches(A, B) :- reaches(A, B, [A]).
reaches(A, B, _) :- calls(A, B).
reaches(A, B, Visited) :- calls(A, Mid), \\+ member(Mid, Visited), reaches(Mid, B, [Mid|Visited]).

% Path finding (returns the call chain)
path(A, B, Path) :- path(A, B, [A], Path).
path(A, B, _, [A, B]) :- calls(A, B).
path(A, B, Visited, [A|Rest]) :- calls(A, Mid), \\+ member(Mid, Visited), path(Mid, B, [Mid|Visited], Rest).

% Dead code: defined function not called by anyone and not an entry point
dead(Name) :- defines(_, Name, function, _), \\+ calls(_, Name), \\+ entry_point(Name).

% Convenience predicates
caller_of(Target, Caller) :- calls(Caller, Target).
callee_of(Source, Callee) :- calls(Source, Callee).
`.trim();

/** Convert a CodeGraph to a Prolog program string */
export function graphToProlog(graph: CodeGraph, entryPoints?: string[]): string {
  const lines: string[] = [];

  // Dynamic declarations
  lines.push(":- dynamic(defines/4).");
  lines.push(":- dynamic(calls/2).");
  lines.push(":- dynamic(imports/3).");
  lines.push(":- dynamic(exports/2).");
  lines.push(":- dynamic(contains/2).");
  lines.push(":- dynamic(entry_point/1).");
  lines.push("");

  // defines(File, Name, Kind, Line).
  for (const d of graph.defines) {
    lines.push(`defines(${escapeAtom(d.file)}, ${escapeAtom(d.name)}, ${escapeAtom(d.kind)}, ${d.line}).`);
  }
  if (graph.defines.length > 0) lines.push("");

  // calls(Caller, Callee).
  for (const c of graph.calls) {
    lines.push(`calls(${escapeAtom(c.caller)}, ${escapeAtom(c.callee)}).`);
  }
  if (graph.calls.length > 0) lines.push("");

  // imports(File, Name, Source).
  for (const i of graph.imports) {
    lines.push(`imports(${escapeAtom(i.file)}, ${escapeAtom(i.name)}, ${escapeAtom(i.source)}).`);
  }
  if (graph.imports.length > 0) lines.push("");

  // exports(File, Name).
  for (const e of graph.exports) {
    lines.push(`exports(${escapeAtom(e.file)}, ${escapeAtom(e.name)}).`);
  }
  if (graph.exports.length > 0) lines.push("");

  // contains(Parent, Child).
  for (const c of graph.contains) {
    lines.push(`contains(${escapeAtom(c.parent)}, ${escapeAtom(c.child)}).`);
  }
  if (graph.contains.length > 0) lines.push("");

  // Entry points
  if (entryPoints && entryPoints.length > 0) {
    for (const ep of entryPoints) {
      lines.push(`entry_point(${escapeAtom(ep)}).`);
    }
  } else {
    // Auto-detect from exports
    const exported = new Set(graph.exports.map((e) => e.name));
    for (const name of exported) {
      lines.push(`entry_point(${escapeAtom(name)}).`);
    }
  }
  lines.push("");

  // Built-in rules
  lines.push(BUILTIN_RULES);

  return lines.join("\n");
}
