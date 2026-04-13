import { describe, it, expect } from "vitest";
import { detectCommunities, cohesionScore } from "../../src/graph/community.js";
import type { CodeGraph } from "../../src/graph/types.js";

function g(calls: Array<[string, string]>, defines: string[] = []): CodeGraph {
  const allNames = new Set(defines);
  for (const [a, b] of calls) {
    allNames.add(a);
    allNames.add(b);
  }
  return {
    defines: [...allNames].map((n) => ({ file: "t.ts", name: n, kind: "function", line: 1 })),
    calls: calls.map(([caller, callee]) => ({ caller, callee })),
    imports: [],
    exports: [],
    contains: [],
  };
}

describe("detectCommunities", () => {
  it("returns empty list for empty graph", () => {
    const communities = detectCommunities({ defines: [], calls: [], imports: [], exports: [], contains: [] });
    expect(communities).toEqual([]);
  });

  it("places isolated nodes into singleton communities", () => {
    // No edges → every node is its own community (matches graphify cluster.py:87-91).
    const graph = g([], ["a", "b", "c"]);
    const communities = detectCommunities(graph);
    expect(communities.length).toBe(3);
    for (const c of communities) {
      expect(c.members.length).toBe(1);
    }
  });

  it("separates two cliques connected by a single bridge", () => {
    // Clique 1: a-b-c fully connected. Clique 2: d-e-f fully connected. Bridge: c-d.
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["a", "c"],
      ["d", "e"], ["e", "f"], ["d", "f"],
      ["c", "d"],
    ];
    const communities = detectCommunities(g(edges));
    expect(communities.length).toBeGreaterThanOrEqual(2);
    // Each clique's nodes should all be in the same community.
    const communityOf = new Map<string, number>();
    for (const c of communities) for (const m of c.members) communityOf.set(m, c.id);
    expect(communityOf.get("a")).toBe(communityOf.get("b"));
    expect(communityOf.get("a")).toBe(communityOf.get("c"));
    expect(communityOf.get("d")).toBe(communityOf.get("e"));
    expect(communityOf.get("d")).toBe(communityOf.get("f"));
    expect(communityOf.get("a")).not.toBe(communityOf.get("d"));
  });

  it("is deterministic across runs with the same input", () => {
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["c", "a"],
      ["d", "e"], ["e", "f"],
    ];
    const r1 = detectCommunities(g(edges));
    const r2 = detectCommunities(g(edges));
    expect(r2).toEqual(r1);
  });

  it("sorts communities by size descending with 0-indexed ids", () => {
    // Large clique (4 nodes) + small clique (2 nodes).
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["c", "d"], ["a", "c"], ["a", "d"], ["b", "d"],
      ["e", "f"],
    ];
    const communities = detectCommunities(g(edges));
    expect(communities[0].id).toBe(0);
    // If there's more than one community, first must be ≥ second by size.
    if (communities.length > 1) {
      expect(communities[0].members.length).toBeGreaterThanOrEqual(communities[1].members.length);
    }
    // IDs should be consecutive integers starting at 0.
    for (let i = 0; i < communities.length; i++) {
      expect(communities[i].id).toBe(i);
    }
  });

  it("members within each community are lexically sorted", () => {
    const communities = detectCommunities(g([], ["charlie", "alice", "bob"]));
    for (const c of communities) {
      const sorted = [...c.members].sort();
      expect(c.members).toEqual(sorted);
    }
  });

  it("cohesion score is intra_edges / max_possible", () => {
    // Triangle (3 nodes, 3 edges). max_possible = 3*2/2 = 3. cohesion = 3/3 = 1.0.
    expect(cohesionScore(3, 3)).toBe(1.0);
    // 4 nodes, 2 internal edges. max = 4*3/2 = 6. cohesion = 2/6 ≈ 0.33.
    expect(cohesionScore(4, 2)).toBeCloseTo(0.33, 2);
    // Singleton: no possible edges — return 0.0 (avoid division by zero).
    expect(cohesionScore(1, 0)).toBe(0);
  });

  it("detected communities carry a cohesion score in [0, 1]", () => {
    const edges: Array<[string, string]> = [
      ["a", "b"], ["b", "c"], ["c", "a"],
      ["d", "e"], ["e", "f"], ["d", "f"],
    ];
    const communities = detectCommunities(g(edges));
    for (const c of communities) {
      expect(c.cohesion).toBeGreaterThanOrEqual(0);
      expect(c.cohesion).toBeLessThanOrEqual(1);
    }
  });

  it("splits oversized communities further (graphify cluster.py:55-56)", () => {
    // Build a barbell-like structure: 20 nodes where everything connects to
    // a central hub. Louvain might place all 20 into one community; the
    // split pass should detect > max(10, 0.25*20)=10 and try to subdivide.
    // We just assert the implementation doesn't crash and returns ≥1
    // community covering all 20 nodes.
    const edges: Array<[string, string]> = [];
    // Two cliques of 10
    const a = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 10 }, (_, i) => `b${i}`);
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) edges.push([a[i], a[j]]);
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) edges.push([b[i], b[j]]);
    edges.push(["a0", "b0"]); // thin bridge

    const communities = detectCommunities(g(edges));
    const totalMembers = communities.reduce((s, c) => s + c.members.length, 0);
    expect(totalMembers).toBe(20);
    expect(communities.length).toBeGreaterThanOrEqual(2);
  });
});
