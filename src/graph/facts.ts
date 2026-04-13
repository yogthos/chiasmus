import type { CodeGraph } from "./types.js";
import { detectCommunities } from "./community.js";
import { detectHubs, detectBridges } from "./insights.js";

/** Escape a string for use as a Prolog atom (single-quoted if needed) */
export function escapeAtom(s: string): string {
  // Simple atoms: lowercase start, only letters/digits/underscore
  if (/^[a-z][a-z0-9_]*$/.test(s)) {
    return s;
  }
  // Quote and escape special chars. Order matters: backslash first, then
  // quotes, then control chars. Without backslash escaping, a trailing `\`
  // would escape the closing quote and leave the atom unterminated.
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0");
  return `'${escaped}'`;
}

/** Shared list membership predicate (used by multiple rule sets) */
export const MEMBER_RULES = `
member(X, [X|_]).
member(X, [_|T]) :- member(X, T).`.trim();

/** Built-in Prolog rules for graph analysis (cycle-safe) */
export const BUILTIN_RULES = `
${MEMBER_RULES}

% Cycle-safe reachability via visited list
reaches(A, B) :- reaches(A, B, [A]).
reaches(A, B, _) :- calls(A, B).
reaches(A, B, Visited) :- calls(A, Mid), \\+ member(Mid, Visited), reaches(Mid, B, [Mid|Visited]).

% Path finding (returns the call chain)
path(A, B, Path) :- path(A, B, [A], Path).
path(A, B, _, [A, B]) :- calls(A, B).
path(A, B, Visited, [A|Rest]) :- calls(A, Mid), \\+ member(Mid, Visited), path(Mid, B, [Mid|Visited], Rest).

% Function-only reachability (for cycle detection).
% Methods are excluded because unqualified method names collide across
% classes — e.g. Map.get and SkillLibrary.get both resolve to "get" in the
% extractor, producing phantom self-loops. An edge is considered
% function-level only if neither endpoint is explicitly kind=method; nodes
% with no defines entry are treated as functions so callers without a file
% (test fixtures, unknowns) still participate.
func_calls(A, B) :- calls(A, B), \\+ defines(_, A, method, _), \\+ defines(_, B, method, _).
func_reaches(A, B) :- func_reaches(A, B, [A]).
func_reaches(A, B, _) :- func_calls(A, B).
func_reaches(A, B, Visited) :- func_calls(A, Mid), \\+ member(Mid, Visited), func_reaches(Mid, B, [Mid|Visited]).

% Dead code: defined function not called by anyone and not an entry point.
% Note: only kind=function is considered — methods (kind=method) are excluded
% because they're typically dispatched dynamically (this.foo(), obj.foo()),
% and static call-graph extraction can't distinguish live from dead methods.
dead(Name) :- defines(_, Name, function, _), \\+ calls(_, Name), \\+ entry_point(Name).

% Convenience predicates
caller_of(Target, Caller) :- calls(Caller, Target).
callee_of(Source, Callee) :- calls(Source, Callee).
`.trim();

export interface PrologOptions {
  /**
   * Include derived-structure facts (community/2, cohesion/2, hub/2,
   * bridge/2) in the fact dump. Default false — these add O(V+E) work and
   * bloat the facts output; callers that need them should opt in. When
   * false, chiasmus_verify can still query them by running the respective
   * analyses directly.
   */
  includeInsights?: boolean;
}

/** Convert a CodeGraph to a Prolog program string */
export function graphToProlog(
  graph: CodeGraph,
  entryPoints?: string[],
  opts: PrologOptions = {},
): string {
  const lines: string[] = [];

  // Dynamic declarations
  lines.push(":- dynamic(defines/4).");
  lines.push(":- dynamic(calls/2).");
  lines.push(":- dynamic(imports/3).");
  lines.push(":- dynamic(exports/2).");
  lines.push(":- dynamic(contains/2).");
  lines.push(":- dynamic(file/2).");
  lines.push(":- dynamic(hyperedge/2).");
  lines.push(":- dynamic(hyperedge_member/2).");
  lines.push(":- dynamic(entry_point/1).");
  lines.push("");

  // file(Path, Language).
  for (const f of graph.files ?? []) {
    lines.push(`file(${escapeAtom(f.path)}, ${escapeAtom(f.language)}).`);
  }
  if (graph.files && graph.files.length > 0) lines.push("");

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

  // hyperedge(Id, Relation). + hyperedge_member(Id, Member).
  if (graph.hyperedges && graph.hyperedges.length > 0) {
    for (const h of graph.hyperedges) {
      lines.push(`hyperedge(${escapeAtom(h.id)}, ${escapeAtom(h.relation)}).`);
      for (const m of h.nodes) {
        lines.push(`hyperedge_member(${escapeAtom(h.id)}, ${escapeAtom(m)}).`);
      }
    }
    lines.push("");
  }

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

  // Insight facts (opt-in via opts.includeInsights).
  if (opts.includeInsights) {
    const communities = detectCommunities(graph);
    for (const c of communities) {
      lines.push(`cohesion(${c.id}, ${c.cohesion}).`);
      for (const m of c.members) {
        lines.push(`community(${escapeAtom(m)}, ${c.id}).`);
      }
    }
    if (communities.length > 0) lines.push("");

    const hubs = detectHubs(graph);
    for (const h of hubs) {
      lines.push(`hub(${escapeAtom(h.name)}, ${h.degree}).`);
    }
    if (hubs.length > 0) lines.push("");

    const bridges = detectBridges(graph);
    for (const b of bridges) {
      lines.push(`bridge(${escapeAtom(b.name)}, ${b.score.toFixed(4)}).`);
    }
    if (bridges.length > 0) lines.push("");
  }

  // Built-in rules
  lines.push(BUILTIN_RULES);

  return lines.join("\n");
}
