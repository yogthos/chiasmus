/**
 * Community detection via Louvain on the call graph.
 *
 * Port of graphify's `graphify/cluster.py` behavior, using
 * graphology-communities-louvain. Deterministic via a seeded RNG
 * (seed=42 matches graphify cluster.py:48).
 *
 * Key behaviors preserved from graphify:
 * - Directed graph is converted to undirected for clustering (cluster.py:71-72)
 * - Isolated nodes get one-node communities each (cluster.py:87-91)
 * - Communities larger than max(10, 0.25 * total_nodes) get a second
 *   Louvain pass on the subgraph (cluster.py:55-56, 94-122)
 * - Final communities are size-sorted descending and reindexed 0..N
 *   (cluster.py:102-104)
 * - Members within each community are lexically sorted for determinism
 * - Cohesion = actual_intra_edges / max_possible_edges (cluster.py:125-133)
 */

import { UndirectedGraph } from "graphology";
import louvainModule from "graphology-communities-louvain";
import type { CodeGraph } from "./types.js";

// NodeNext/CJS interop: graphology-communities-louvain is `module.exports = fn`
// but NodeNext surfaces the import as the namespace object. Cast to callable.
const louvain = louvainModule as unknown as (
  graph: UndirectedGraph,
  options?: { rng?: () => number },
) => Record<string, number>;

export interface Community {
  id: number;
  members: string[];
  cohesion: number;
}

const DEFAULT_SEED = 42;

/** mulberry32 PRNG — deterministic, seeded, uniform in [0, 1). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cohesion score: ratio of actual intra-community edges to the maximum
 * possible (n choose 2). Returns 0 for communities of size 0 or 1 where the
 * denominator is undefined.
 */
export function cohesionScore(memberCount: number, intraEdges: number): number {
  if (memberCount < 2) return 0;
  const max = (memberCount * (memberCount - 1)) / 2;
  return Math.round((intraEdges / max) * 100) / 100;
}

export interface DetectOptions {
  /** PRNG seed. Default 42. */
  seed?: number;
}

export function detectCommunities(
  graph: CodeGraph,
  opts: DetectOptions = {},
): Community[] {
  const seed = opts.seed ?? DEFAULT_SEED;

  // Collect every node that participates in the graph.
  const nodes = new Set<string>();
  for (const d of graph.defines) nodes.add(d.name);
  for (const c of graph.calls) {
    nodes.add(c.caller);
    nodes.add(c.callee);
  }

  if (nodes.size === 0) return [];

  const gg = new UndirectedGraph();
  for (const n of nodes) gg.addNode(n);
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    if (!gg.hasEdge(c.caller, c.callee)) {
      gg.addEdge(c.caller, c.callee);
    }
  }

  // Run Louvain only if there are edges; otherwise everyone is a singleton.
  let assignments: Record<string, number>;
  if (gg.size === 0) {
    assignments = {};
    let i = 0;
    for (const n of nodes) assignments[n] = i++;
  } else {
    assignments = louvain(gg, { rng: makeRng(seed) });
    // Isolated nodes missing from the Louvain output get their own community.
    let nextId = 0;
    for (const cid of Object.values(assignments)) if (cid >= nextId) nextId = cid + 1;
    for (const n of nodes) {
      if (!(n in assignments)) assignments[n] = nextId++;
    }
  }

  // Split oversized communities: graphify cluster.py:55-56, 94-122.
  const splitThreshold = Math.max(10, Math.floor(0.25 * nodes.size));
  let next = Math.max(-1, ...Object.values(assignments)) + 1;
  const byCommunity = groupBy(assignments);
  for (const [cidStr, members] of Object.entries(byCommunity)) {
    if (members.length <= splitThreshold) continue;
    // Build subgraph induced by these members.
    const sub = new UndirectedGraph();
    for (const m of members) sub.addNode(m);
    for (const c of graph.calls) {
      if (c.caller === c.callee) continue;
      if (!sub.hasNode(c.caller) || !sub.hasNode(c.callee)) continue;
      if (!sub.hasEdge(c.caller, c.callee)) sub.addEdge(c.caller, c.callee);
    }
    if (sub.size === 0) continue;
    const subAssign = louvain(sub, { rng: makeRng(seed + Number(cidStr) + 1) });
    const distinctSubIds = new Set(Object.values(subAssign));
    if (distinctSubIds.size <= 1) continue; // No split achieved.
    // Re-map: keep one subgroup under the original cid, move the rest to new ids.
    const subIds = [...distinctSubIds];
    const remap = new Map<number, number>();
    remap.set(subIds[0], Number(cidStr));
    for (let i = 1; i < subIds.length; i++) remap.set(subIds[i], next++);
    for (const [member, subId] of Object.entries(subAssign)) {
      assignments[member] = remap.get(subId)!;
    }
  }

  // Reindex communities by descending size, lexical tiebreak on first member.
  const grouped = groupBy(assignments);
  const orderedCommunities = Object.entries(grouped)
    .map(([_, members]) => [...members].sort())
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  // Count intra-edges per community for cohesion.
  const memberToCommunity = new Map<string, number>();
  orderedCommunities.forEach((members, id) => {
    for (const m of members) memberToCommunity.set(m, id);
  });
  const intraCounts = new Array(orderedCommunities.length).fill(0);
  const seen = new Set<string>();
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const cid = memberToCommunity.get(c.caller);
    const did = memberToCommunity.get(c.callee);
    if (cid === undefined || did === undefined) continue;
    if (cid !== did) continue;
    const key = c.caller < c.callee ? `${c.caller}|${c.callee}` : `${c.callee}|${c.caller}`;
    if (seen.has(key)) continue;
    seen.add(key);
    intraCounts[cid]++;
  }

  return orderedCommunities.map((members, id) => ({
    id,
    members,
    cohesion: cohesionScore(members.length, intraCounts[id]),
  }));
}

function groupBy(assignments: Record<string, number>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [node, cid] of Object.entries(assignments)) {
    const k = String(cid);
    if (!out[k]) out[k] = [];
    out[k].push(node);
  }
  return out;
}
