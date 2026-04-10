import { describe, it, expect } from "vitest";
import { runAnalysisFromGraph } from "../src/graph/analyses.js";
import type { CodeGraph } from "../src/graph/types.js";

const emptyGraph: CodeGraph = {
  defines: [],
  calls: [],
  imports: [],
  exports: [],
  contains: [],
};

describe("graph analysis query escaping", () => {
  it("handles target names with spaces", async () => {
    const graph: CodeGraph = {
      ...emptyGraph,
      defines: [
        { file: "test.ts", name: "my function", kind: "function", line: 1 },
      ],
      calls: [{ caller: "my function", callee: "helper" }],
      exports: [{ file: "test.ts", name: "my function" }],
    };

    const result = await runAnalysisFromGraph(graph, {
      analysis: "callers",
      target: "my function",
    });

    expect(result.result).not.toEqual(
      expect.objectContaining({ error: expect.stringContaining("error") }),
    );
  });

  it("handles target names with single quotes", async () => {
    const graph: CodeGraph = {
      ...emptyGraph,
      defines: [
        { file: "test.ts", name: "it's", kind: "function", line: 1 },
      ],
      calls: [{ caller: "it's", callee: "helper" }],
      exports: [{ file: "test.ts", name: "it's" }],
    };

    const result = await runAnalysisFromGraph(graph, {
      analysis: "callers",
      target: "it's",
    });

    expect(result.result).not.toEqual(
      expect.objectContaining({ error: expect.stringContaining("error") }),
    );
  });

  it("handles target names with parentheses", async () => {
    const result = await runAnalysisFromGraph(emptyGraph, {
      analysis: "callers",
      target: "foo(bar)",
    });

    expect(result.result).not.toEqual(
      expect.objectContaining({ error: expect.stringContaining("error") }),
    );
  });

  it("handles from/to with special chars for reachability", async () => {
    const result = await runAnalysisFromGraph(emptyGraph, {
      analysis: "reachability",
      from: "node A",
      to: "node B",
    });

    expect(result.result).not.toEqual(
      expect.objectContaining({ error: expect.stringContaining("error") }),
    );
  });
});
