import { UndirectedGraph } from "graphology";
import betweennessModule from "graphology-metrics/centrality/betweenness.js";
import type { CodeGraph } from "./types.js";
import { detectCommunities, type Community } from "./community.js";
import { buildUndirectedGraph, collectNodes, undirectedDegree, forEachUndirectedEdge } from "./graph-util.js";

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

export type SurpriseReason = "cross-community" | "peripheral-to-hub";

export interface SurprisingConnection {
  source: string;
  target: string;
  score: number;
  reasons: SurpriseReason[];
}

export interface HubOptions {
  topN?: number;
}

const DEFAULT_HUB_TOP_N = 10;

export function detectHubs(graph: CodeGraph, opts: HubOptions = {}): Hub[] {
  const topN = opts.topN ?? DEFAULT_HUB_TOP_N;
  const degree = undirectedDegree(graph);

  return [...degree.entries()]
    .map(([name, d]) => ({ name, degree: d }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, topN);
}

export function detectBridges(graph: CodeGraph): Bridge[] {
  const nodes = collectNodes(graph);
  if (nodes.size === 0) return [];

  const gg = buildUndirectedGraph(graph, nodes);
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

export interface SurpriseOptions {
  /** Pre-computed communities. When omitted, this function runs Louvain itself. */
  communities?: Community[];
  topN?: number;
}

/**
 * Score each unique undirected edge for "surprise": cross-community edges
 * and peripheral-to-hub edges each add 1. Scoring weights match graphify's
 * _surprise_score; signals chiasmus doesn't emit yet (confidence labels,
 * semantic similarity, cross-repo buckets) simply contribute 0.
 */
export function detectSurprisingConnections(
  graph: CodeGraph,
  options: SurpriseOptions = {},
): SurprisingConnection[] {
  const communities = options.communities ?? detectCommunities(graph);
  const topN = options.topN ?? 10;

  const nodeToCommunity = new Map<string, number>();
  for (const c of communities) for (const m of c.members) nodeToCommunity.set(m, c.id);

  const degree = undirectedDegree(graph);

  const candidates: SurprisingConnection[] = [];
  forEachUndirectedEdge(graph, (a, b) => {
    let score = 0;
    const reasons: SurpriseReason[] = [];

    const ca = nodeToCommunity.get(a);
    const cb = nodeToCommunity.get(b);
    if (ca !== undefined && cb !== undefined && ca !== cb) {
      score += 1;
      reasons.push("cross-community");
    }

    const da = degree.get(a) ?? 0;
    const db = degree.get(b) ?? 0;
    if (Math.min(da, db) <= 2 && Math.max(da, db) >= 5) {
      score += 1;
      reasons.push("peripheral-to-hub");
    }

    if (score > 0) {
      candidates.push({ source: a, target: b, score, reasons });
    }
  });

  candidates.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (x.source !== y.source) return x.source < y.source ? -1 : 1;
    return x.target < y.target ? -1 : x.target > y.target ? 1 : 0;
  });

  return candidates.slice(0, topN);
}
