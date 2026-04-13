/**
 * Graph insight analyses that surface non-obvious structural signals.
 *
 * - `detectHubs`   : highest-degree nodes (port of graphify analyze.py:39-58)
 * - `detectBridges`: highest-betweenness nodes (port of graphify analyze.py:362-383)
 * - `detectSurprisingConnections`: cross-community edges scored for
 *    unexpectedness (port of graphify analyze.py:131-246)
 */

import { UndirectedGraph } from "graphology";
import betweennessModule from "graphology-metrics/centrality/betweenness.js";
import type { CodeGraph } from "./types.js";
import { detectCommunities, type Community } from "./community.js";

const betweennessCentrality = betweennessModule as unknown as (
  graph: UndirectedGraph,
  options?: { normalized?: boolean },
) => Record<string, number>;

export interface Hub {
  name: string;
  degree: number;
}

export interface Bridge {
  name: string;
  score: number;
}

export interface HubOptions {
  topN?: number;
}

const DEFAULT_HUB_TOP_N = 10;

/**
 * Degree-based hub detection. Counts every edge endpoint (callers + callees)
 * exactly once per unique pair — a node reciprocally connected to another
 * counts as degree 2 (one in, one out).
 *
 * graphify filters "file hubs" and "concept nodes" before ranking
 * (analyze.py:11-36, 93-109). Chiasmus's call graph today has no file- or
 * concept-level nodes in the `calls` relation, so those filters are no-ops
 * here. When file-level nodes land in Prolog facts, this site can grow the
 * same exclusions.
 */
export function detectHubs(graph: CodeGraph, opts: HubOptions = {}): Hub[] {
  const topN = opts.topN ?? DEFAULT_HUB_TOP_N;
  const degree = new Map<string, number>();

  const seen = new Set<string>();
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const key = c.caller < c.callee ? `${c.caller}|${c.callee}` : `${c.callee}|${c.caller}`;
    if (seen.has(key)) continue;
    seen.add(key);
    degree.set(c.caller, (degree.get(c.caller) ?? 0) + 1);
    degree.set(c.callee, (degree.get(c.callee) ?? 0) + 1);
  }

  const entries = [...degree.entries()]
    .map(([name, d]) => ({ name, degree: d }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

  return entries.slice(0, topN);
}

/**
 * Bridge detection: nodes with highest exact normalized betweenness centrality.
 * Mirrors graphify analyze.py:362-383 — full (no-sampling) betweenness, top 3,
 * score > 0.
 */
export function detectBridges(graph: CodeGraph): Bridge[] {
  const nodes = new Set<string>();
  for (const c of graph.calls) { nodes.add(c.caller); nodes.add(c.callee); }
  for (const d of graph.defines) nodes.add(d.name);
  if (nodes.size === 0) return [];

  const gg = new UndirectedGraph();
  for (const n of nodes) gg.addNode(n);
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    if (!gg.hasEdge(c.caller, c.callee)) gg.addEdge(c.caller, c.callee);
  }

  const scores = betweennessCentrality(gg, { normalized: true });
  return Object.entries(scores)
    .filter(([, s]) => s > 0)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, 3);
}

export interface SurprisingConnection {
  source: string;
  target: string;
  score: number;
  reason: string;
}

/**
 * Port of graphify analyze.py:131-184 `_surprise_score`, reduced to the
 * terms that chiasmus's call graph supports today. Scoring weights are the
 * exact constants graphify uses — this keeps our results comparable to
 * graphify's output format. Terms that depend on signals chiasmus doesn't
 * have yet (confidence labels, semantic_similar_to edges, cross-repo
 * categories) contribute 0 until Phase C adds them.
 */
export function detectSurprisingConnections(
  graph: CodeGraph,
  options: { communities?: Community[]; topN?: number } = {},
): SurprisingConnection[] {
  const communities = options.communities ?? detectCommunities(graph);
  const topN = options.topN ?? 10;

  const nodeToCommunity = new Map<string, number>();
  for (const c of communities) for (const m of c.members) nodeToCommunity.set(m, c.id);

  const degree = new Map<string, number>();
  const seenEdges = new Set<string>();
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const key = c.caller < c.callee ? `${c.caller}|${c.callee}` : `${c.callee}|${c.caller}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    degree.set(c.caller, (degree.get(c.caller) ?? 0) + 1);
    degree.set(c.callee, (degree.get(c.callee) ?? 0) + 1);
  }

  const candidates: SurprisingConnection[] = [];
  const handled = new Set<string>();
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const key = c.caller < c.callee ? `${c.caller}|${c.callee}` : `${c.callee}|${c.caller}`;
    if (handled.has(key)) continue;
    handled.add(key);

    let score = 0;
    const reasons: string[] = [];

    // Cross-community bonus (+1), per graphify analyze.py:168-169.
    const ca = nodeToCommunity.get(c.caller);
    const cb = nodeToCommunity.get(c.callee);
    if (ca !== undefined && cb !== undefined && ca !== cb) {
      score += 1;
      reasons.push("cross-community");
    }

    // Peripheral → hub bonus (+1), per graphify analyze.py:176-180.
    const da = degree.get(c.caller) ?? 0;
    const db = degree.get(c.callee) ?? 0;
    if (Math.min(da, db) <= 2 && Math.max(da, db) >= 5) {
      score += 1;
      reasons.push("peripheral→hub");
    }

    if (score > 0) {
      candidates.push({
        source: c.caller,
        target: c.callee,
        score,
        reason: reasons.join(", "),
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });

  return candidates.slice(0, topN);
}
