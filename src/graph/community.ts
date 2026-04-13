import { UndirectedGraph } from "graphology";
import louvainModule from "graphology-communities-louvain";
import type { CodeGraph } from "./types.js";
import { collectNodes, buildUndirectedGraph, forEachUndirectedEdge } from "./graph-util.js";

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
 * possible (n choose 2). Returns 0 when the denominator is undefined
 * (singleton or empty community).
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
  const nodes = collectNodes(graph);
  if (nodes.size === 0) return [];

  const gg = buildUndirectedGraph(graph, nodes);

  let assignments: Record<string, number>;
  if (gg.size === 0) {
    assignments = {};
    let i = 0;
    for (const n of nodes) assignments[n] = i++;
  } else {
    assignments = louvain(gg, { rng: makeRng(seed) });
    // Louvain skips nodes with no edges — assign each isolate its own community.
    let nextId = 0;
    for (const cid of Object.values(assignments)) if (cid >= nextId) nextId = cid + 1;
    for (const n of nodes) {
      if (!(n in assignments)) assignments[n] = nextId++;
    }
  }

  // Recursively split any community larger than max(10, 0.25·n). Without
  // this, Louvain leaves mega-communities that swamp the rest of the output.
  const splitThreshold = Math.max(10, Math.floor(0.25 * nodes.size));
  let next = Math.max(-1, ...Object.values(assignments)) + 1;
  const byCommunity = groupBy(assignments);
  for (const [cidStr, members] of Object.entries(byCommunity)) {
    if (members.length <= splitThreshold) continue;
    const memberSet = new Set(members);
    const sub = buildUndirectedGraph(graph, memberSet);
    if (sub.size === 0) continue;
    const subAssign = louvain(sub, { rng: makeRng(seed + Number(cidStr) + 1) });
    const distinctSubIds = new Set(Object.values(subAssign));
    if (distinctSubIds.size <= 1) continue;
    const subIds = [...distinctSubIds];
    const remap = new Map<number, number>();
    remap.set(subIds[0], Number(cidStr));
    for (let i = 1; i < subIds.length; i++) remap.set(subIds[i], next++);
    for (const [member, subId] of Object.entries(subAssign)) {
      assignments[member] = remap.get(subId)!;
    }
  }

  // Reindex by descending size, lexical tiebreak on first member.
  const grouped = groupBy(assignments);
  const orderedCommunities = Object.entries(grouped)
    .map(([_, members]) => [...members].sort())
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  const memberToCommunity = new Map<string, number>();
  orderedCommunities.forEach((members, id) => {
    for (const m of members) memberToCommunity.set(m, id);
  });
  const intraCounts = new Array(orderedCommunities.length).fill(0);
  forEachUndirectedEdge(graph, (a, b) => {
    const cid = memberToCommunity.get(a);
    const did = memberToCommunity.get(b);
    if (cid !== undefined && cid === did) intraCounts[cid]++;
  });

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
