import { describe, it, expect } from "vitest";
import { graphDiff } from "../../src/graph/diff.js";
import type { CodeGraph } from "../../src/graph/types.js";

function graphOf(
  defines: Array<[string, string]>, // [file, name]
  calls: Array<[string, string]>,
): CodeGraph {
  return {
    defines: defines.map(([file, name]) => ({ file, name, kind: "function", line: 1 })),
    calls: calls.map(([caller, callee]) => ({ caller, callee })),
    imports: [],
    exports: [],
    contains: [],
  };
}

describe("graphDiff", () => {
  it("returns no changes for identical graphs", () => {
    const g = graphOf([["a.ts", "foo"], ["a.ts", "bar"]], [["foo", "bar"]]);
    const d = graphDiff(g, g);
    expect(d.addedNodes).toEqual([]);
    expect(d.removedNodes).toEqual([]);
    expect(d.addedEdges).toEqual([]);
    expect(d.removedEdges).toEqual([]);
  });

  it("detects added nodes", () => {
    const before = graphOf([["a.ts", "foo"]], []);
    const after = graphOf([["a.ts", "foo"], ["a.ts", "bar"]], []);
    const d = graphDiff(before, after);
    expect(d.addedNodes).toContain("bar");
    expect(d.removedNodes).toEqual([]);
  });

  it("detects removed nodes", () => {
    const before = graphOf([["a.ts", "foo"], ["a.ts", "bar"]], []);
    const after = graphOf([["a.ts", "foo"]], []);
    const d = graphDiff(before, after);
    expect(d.removedNodes).toContain("bar");
    expect(d.addedNodes).toEqual([]);
  });

  it("detects added edges", () => {
    const before = graphOf([["a.ts", "a"], ["a.ts", "b"]], []);
    const after = graphOf([["a.ts", "a"], ["a.ts", "b"]], [["a", "b"]]);
    const d = graphDiff(before, after);
    expect(d.addedEdges).toEqual([{ source: "a", target: "b" }]);
    expect(d.removedEdges).toEqual([]);
  });

  it("detects removed edges", () => {
    const before = graphOf([["a.ts", "a"], ["a.ts", "b"]], [["a", "b"]]);
    const after = graphOf([["a.ts", "a"], ["a.ts", "b"]], []);
    const d = graphDiff(before, after);
    expect(d.removedEdges).toEqual([{ source: "a", target: "b" }]);
  });

  it("uses (source, target) as edge key for directed graphs", () => {
    // Reversing the direction of an edge is one remove + one add.
    const before = graphOf([["t.ts", "a"], ["t.ts", "b"]], [["a", "b"]]);
    const after = graphOf([["t.ts", "a"], ["t.ts", "b"]], [["b", "a"]]);
    const d = graphDiff(before, after);
    expect(d.addedEdges).toEqual([{ source: "b", target: "a" }]);
    expect(d.removedEdges).toEqual([{ source: "a", target: "b" }]);
  });

  it("produces a human-readable summary", () => {
    const before = graphOf([["t.ts", "a"]], []);
    const after = graphOf([["t.ts", "a"], ["t.ts", "b"]], [["a", "b"]]);
    const d = graphDiff(before, after);
    expect(d.summary).toMatch(/1 new node/);
    expect(d.summary).toMatch(/1 new edge/);
  });

  it("summary pluralizes correctly", () => {
    const before = graphOf([], []);
    const after = graphOf([["t.ts", "a"], ["t.ts", "b"]], [["a", "b"], ["a", "b"]]);
    // Duplicate edges in input should be deduped; 2 nodes 1 edge.
    const d = graphDiff(before, after);
    expect(d.summary).toMatch(/2 new nodes/);
  });

  it("handles complete replacement", () => {
    const before = graphOf([["a.ts", "old1"], ["a.ts", "old2"]], [["old1", "old2"]]);
    const after = graphOf([["b.ts", "new1"], ["b.ts", "new2"]], [["new1", "new2"]]);
    const d = graphDiff(before, after);
    expect(d.addedNodes.sort()).toEqual(["new1", "new2"]);
    expect(d.removedNodes.sort()).toEqual(["old1", "old2"]);
    expect(d.addedEdges).toEqual([{ source: "new1", target: "new2" }]);
    expect(d.removedEdges).toEqual([{ source: "old1", target: "old2" }]);
  });
});
