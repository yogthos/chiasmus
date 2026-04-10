import { describe, it, expect } from "vitest";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
import type { CodeGraph } from "../../src/graph/types.js";

function makeGraph(overrides: Partial<CodeGraph> = {}): CodeGraph {
  return {
    defines: overrides.defines ?? [],
    calls: overrides.calls ?? [],
    imports: overrides.imports ?? [],
    exports: overrides.exports ?? [],
    contains: overrides.contains ?? [],
  };
}

describe("layer-violation analysis", () => {
  it("detects a call that skips a layer", async () => {
    const graph = makeGraph({
      defines: [
        { file: "src/handlers/user.ts", name: "handleCreateUser", kind: "function", line: 1 },
        { file: "src/services/user.ts", name: "createUser", kind: "function", line: 1 },
        { file: "src/db/client.ts", name: "query", kind: "function", line: 1 },
      ],
      calls: [
        { caller: "handleCreateUser", callee: "query" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, {
      analysis: "layer-violation",
      entryPoints: ["handleCreateUser", "createUser", "query"],
    });

    expect(r.analysis).toBe("layer-violation");
    const violations = r.result as Array<{ caller: string; callee: string; callerLayer: string; calleeLayer: string }>;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].caller).toBe("handleCreateUser");
    expect(violations[0].callee).toBe("query");
  });

  it("allows calls within the same layer", async () => {
    const graph = makeGraph({
      defines: [
        { file: "src/handlers/user.ts", name: "listUsers", kind: "function", line: 1 },
        { file: "src/handlers/auth.ts", name: "checkAuth", kind: "function", line: 1 },
      ],
      calls: [
        { caller: "listUsers", callee: "checkAuth" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, {
      analysis: "layer-violation",
      entryPoints: ["listUsers", "checkAuth"],
    });

    const violations = r.result as Array<{ caller: string; callee: string }>;
    expect(violations.length).toBe(0);
  });

  it("allows calls to adjacent layer", async () => {
    const graph = makeGraph({
      defines: [
        { file: "src/handlers/user.ts", name: "handleGetUser", kind: "function", line: 1 },
        { file: "src/services/user.ts", name: "getUser", kind: "function", line: 1 },
      ],
      calls: [
        { caller: "handleGetUser", callee: "getUser" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, {
      analysis: "layer-violation",
      entryPoints: ["handleGetUser", "getUser"],
    });

    const violations = r.result as Array<{ caller: string; callee: string }>;
    expect(violations.length).toBe(0);
  });

  it("detects multiple violations", async () => {
    const graph = makeGraph({
      defines: [
        { file: "src/handlers/user.ts", name: "h1", kind: "function", line: 1 },
        { file: "src/handlers/admin.ts", name: "h2", kind: "function", line: 1 },
        { file: "src/repositories/user.ts", name: "r1", kind: "function", line: 1 },
      ],
      calls: [
        { caller: "h1", callee: "r1" },
        { caller: "h2", callee: "r1" },
      ],
    });

    const r = await runAnalysisFromGraph(graph, {
      analysis: "layer-violation",
      entryPoints: ["h1", "h2", "r1"],
    });

    const violations = r.result as Array<{ caller: string; callee: string }>;
    expect(violations.length).toBe(2);
  });

  it("returns empty when no calls exist", async () => {
    const graph = makeGraph({
      defines: [
        { file: "src/handlers/user.ts", name: "h1", kind: "function", line: 1 },
      ],
    });

    const r = await runAnalysisFromGraph(graph, {
      analysis: "layer-violation",
    });

    const violations = r.result as Array<{ caller: string; callee: string }>;
    expect(violations.length).toBe(0);
  });
});
