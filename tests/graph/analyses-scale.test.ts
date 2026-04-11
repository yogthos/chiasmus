import { describe, it, expect } from "vitest";
import {
  runAnalysisFromGraph,
  buildFactsResult,
  DEFAULT_FACTS_MAX_BYTES,
} from "../../src/graph/analyses.js";
import type { CodeGraph, DefinesFact, CallsFact } from "../../src/graph/types.js";

/**
 * Scale tests for graph analyses.
 *
 * The Prolog-based implementation of cycles/impact/reachability/path/dead-code
 * times out on realistic codebases (a few hundred functions) because Tau Prolog
 * lacks tabling and `func_reaches(X, X)` enumerates the full reachability graph
 * from every X. These tests lock in the native-algorithm replacement by
 * asserting each analysis completes within a tight wall-clock budget on graphs
 * large enough to expose the old blow-up.
 */

/** Build a chain graph: f0 → f1 → f2 → ... → fN-1 */
function makeChain(n: number): CodeGraph {
  const defines = Array.from({ length: n }, (_, i) => ({
    file: "chain.ts",
    name: `f${i}`,
    kind: "function" as const,
    line: i + 1,
  }));
  const calls = Array.from({ length: n - 1 }, (_, i) => ({
    caller: `f${i}`,
    callee: `f${i + 1}`,
  }));
  return { defines, calls, imports: [], exports: [], contains: [] };
}

/** Build a graph with `groups` disjoint cycles of `size` nodes each, plus noise. */
function makeCyclicGraph(groups: number, size: number): CodeGraph {
  const defines: DefinesFact[] = [];
  const calls: CallsFact[] = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < size; i++) {
      const name = `c${g}_${i}`;
      defines.push({ file: `g${g}.ts`, name, kind: "function" as const, line: i + 1 });
      const nextName = `c${g}_${(i + 1) % size}`;
      calls.push({ caller: name, callee: nextName });
    }
  }
  // Non-cyclic noise: each cycle node also calls a dead leaf function.
  for (let g = 0; g < groups; g++) {
    const leaf = `leaf${g}`;
    defines.push({ file: `g${g}.ts`, name: leaf, kind: "function" as const, line: 100 });
    calls.push({ caller: `c${g}_0`, callee: leaf });
  }
  return { defines, calls, imports: [], exports: [], contains: [] };
}

describe("graph analyses — scale", () => {
  it(
    "cycles on 300-node graph with 20 disjoint cycles finishes in < 1s",
    async () => {
      const graph = makeCyclicGraph(20, 15); // 300 cycle nodes + 20 leaves = 320
      const t0 = Date.now();
      const r = await runAnalysisFromGraph(graph, { analysis: "cycles" });
      const elapsed = Date.now() - t0;

      const cycleNodes = r.result as string[];
      // All 300 cycle members should be reported.
      expect(cycleNodes.length).toBe(300);
      // Leaves must not appear.
      expect(cycleNodes).not.toContain("leaf0");
      // Must finish well under a second.
      expect(elapsed).toBeLessThan(1000);
    },
    5000,
  );

  it(
    "impact on a 500-node chain returns every ancestor in < 500ms",
    async () => {
      const graph = makeChain(500);
      const t0 = Date.now();
      const r = await runAnalysisFromGraph(graph, { analysis: "impact", target: "f499" });
      const elapsed = Date.now() - t0;

      const affected = r.result as string[];
      // Every earlier function in the chain is a transitive caller of f499.
      expect(affected.length).toBe(499);
      expect(affected).toContain("f0");
      expect(affected).toContain("f250");
      expect(affected).toContain("f498");
      expect(elapsed).toBeLessThan(500);
    },
    5000,
  );

  it(
    "reachability on a 1000-node chain finishes in < 200ms",
    async () => {
      const graph = makeChain(1000);
      const t0 = Date.now();
      const r = await runAnalysisFromGraph(graph, { analysis: "reachability", from: "f0", to: "f999" });
      const elapsed = Date.now() - t0;

      expect((r.result as any).reachable).toBe(true);
      expect(elapsed).toBeLessThan(200);
    },
    5000,
  );

  it(
    "path on a 500-node chain returns a chain including the endpoints in < 500ms",
    async () => {
      const graph = makeChain(500);
      const t0 = Date.now();
      const r = await runAnalysisFromGraph(graph, { analysis: "path", from: "f0", to: "f499" });
      const elapsed = Date.now() - t0;

      const paths = (r.result as any).paths as unknown[];
      expect(paths.length).toBeGreaterThan(0);
      const first = JSON.stringify(paths[0]);
      expect(first).toContain("f0");
      expect(first).toContain("f499");
      expect(elapsed).toBeLessThan(500);
    },
    5000,
  );

  it(
    "dead-code on a 1000-function graph with 100 orphans finishes in < 500ms",
    async () => {
      const defines = Array.from({ length: 1000 }, (_, i) => ({
        file: "t.ts",
        name: `fn${i}`,
        kind: "function" as const,
        line: i + 1,
      }));
      // fn0 calls everyone in [1..899], 900..999 are orphans, fn0 is exported.
      const calls: CallsFact[] = Array.from({ length: 899 }, (_, i) => ({
        caller: "fn0",
        callee: `fn${i + 1}`,
      }));
      const exports = [{ file: "t.ts", name: "fn0" }];
      const graph: CodeGraph = { defines, calls, imports: [], exports, contains: [] };

      const t0 = Date.now();
      const r = await runAnalysisFromGraph(graph, { analysis: "dead-code" });
      const elapsed = Date.now() - t0;

      const dead = r.result as string[];
      expect(dead.length).toBe(100);
      expect(dead).toContain("fn900");
      expect(dead).toContain("fn999");
      expect(dead).not.toContain("fn0");
      expect(dead).not.toContain("fn500");
      expect(elapsed).toBeLessThan(500);
    },
    5000,
  );

  it(
    "callers/callees on a 500-node dense graph respond in < 100ms",
    async () => {
      const defines = Array.from({ length: 500 }, (_, i) => ({
        file: "t.ts",
        name: `n${i}`,
        kind: "function" as const,
        line: i + 1,
      }));
      // Every node calls the next three — O(V) edges, simple dense-ish pattern.
      const calls: CallsFact[] = [];
      for (let i = 0; i < 500; i++) {
        for (let k = 1; k <= 3 && i + k < 500; k++) {
          calls.push({ caller: `n${i}`, callee: `n${i + k}` });
        }
      }
      const graph: CodeGraph = { defines, calls, imports: [], exports: [], contains: [] };

      const t0 = Date.now();
      const callersR = await runAnalysisFromGraph(graph, { analysis: "callers", target: "n250" });
      const calleesR = await runAnalysisFromGraph(graph, { analysis: "callees", target: "n250" });
      const elapsed = Date.now() - t0;

      expect((callersR.result as string[]).sort()).toEqual(["n247", "n248", "n249"]);
      expect((calleesR.result as string[]).sort()).toEqual(["n251", "n252", "n253"]);
      expect(elapsed).toBeLessThan(100);
    },
    5000,
  );
});

describe("facts output size cap", () => {
  it("small graphs return the full program string via runAnalysisFromGraph", async () => {
    const graph: CodeGraph = {
      defines: [{ file: "t.ts", name: "a", kind: "function", line: 1 }],
      calls: [{ caller: "a", callee: "b" }],
      imports: [],
      exports: [],
      contains: [],
    };
    const r = await runAnalysisFromGraph(graph, { analysis: "facts" });
    expect(typeof r.result).toBe("string");
    expect(r.result as string).toContain("defines(");
    expect(r.result as string).toContain("calls(a, b)");
  });

  it("default cap is 10 MB (matches the agreed budget)", () => {
    expect(DEFAULT_FACTS_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("buildFactsResult returns the raw program under the cap", () => {
    const graph: CodeGraph = {
      defines: [{ file: "t.ts", name: "foo", kind: "function", line: 1 }],
      calls: [{ caller: "foo", callee: "bar" }],
      imports: [],
      exports: [],
      contains: [],
    };
    const res = buildFactsResult(graph, undefined, 1_000_000);
    expect(typeof res).toBe("string");
    expect(res as string).toContain("defines(");
  });

  it("buildFactsResult returns an error object when the program exceeds the cap", () => {
    // Tiny cap so a one-fact program already exceeds it.
    const graph: CodeGraph = {
      defines: [{ file: "t.ts", name: "someFunctionName", kind: "function", line: 1 }],
      calls: [{ caller: "someFunctionName", callee: "otherFunction" }],
      imports: [],
      exports: [],
      contains: [],
    };
    const res = buildFactsResult(graph, undefined, 50);
    expect(typeof res).toBe("object");
    const obj = res as { error: string; size: number; limit: number };
    expect(obj.error).toMatch(/exceeds/i);
    expect(obj.limit).toBe(50);
    expect(obj.size).toBeGreaterThan(50);
  });

  it("runAnalysisFromGraph surfaces the cap error on an oversize graph", async () => {
    // Build a graph whose Prolog program will comfortably exceed 10MB.
    // Each calls fact is ~25 bytes (`calls(fxxxxx, fxxxxxx).\n`). We need
    // ~420k facts for >10MB. Keep names short so generation stays fast.
    const calls: CallsFact[] = [];
    const defines: DefinesFact[] = [];
    const targetBytes = DEFAULT_FACTS_MAX_BYTES + 1024;
    // Over-allocate: each fact emits ~60 bytes once graphToProlog adds the
    // defines line too. 200k pairs → ~12MB of output.
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      defines.push({ file: "t.ts", name: `f${i}`, kind: "function", line: i });
      calls.push({ caller: `f${i}`, callee: `f${(i + 1) % n}` });
    }
    const graph: CodeGraph = { defines, calls, imports: [], exports: [], contains: [] };

    const r = await runAnalysisFromGraph(graph, { analysis: "facts" });
    // runAnalysisFromGraph uses the default cap. Expect the error-shaped
    // result, not a raw program string.
    expect(typeof r.result).toBe("object");
    const obj = r.result as { error: string; size: number; limit: number };
    expect(obj.error).toMatch(/exceeds/i);
    expect(obj.limit).toBe(DEFAULT_FACTS_MAX_BYTES);
    expect(obj.size).toBeGreaterThan(targetBytes);
  }, 30000);
});
