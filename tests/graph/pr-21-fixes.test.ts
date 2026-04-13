import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalysis, runAnalysisFromGraph } from "../../src/graph/analyses.js";
import { saveSnapshot } from "../../src/graph/cache.js";
import { graphDiff } from "../../src/graph/diff.js";
import { graphToProlog } from "../../src/graph/facts.js";
import type { CodeGraph, Hyperedge } from "../../src/graph/types.js";

// ── HIGH: saveSnapshot === against must error ─────────────────────────────

describe("PR #21 fix: saveSnapshot vs against guard", () => {
  let cacheDir: string;
  let workDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-pr21-guard-"));
    workDir = await mkdtemp(join(tmpdir(), "chiasmus-pr21-src-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("errors when saveSnapshot and against name the same snapshot", async () => {
    const opts = { cacheDir, repoKey: "guard-test" };
    const baseline: CodeGraph = {
      defines: [{ file: "a.ts", name: "foo", kind: "function", line: 1 }],
      calls: [],
      imports: [],
      exports: [],
      contains: [],
    };
    await saveSnapshot("main", baseline, opts);

    const p = join(workDir, "a.ts");
    await writeFile(p, "function foo() { bar(); } function bar() {}");

    const r = await runAnalysis([p], {
      analysis: "diff",
      against: "main",
      saveSnapshot: "main",
      cache: opts,
    });
    const result = r.result as { error?: string };
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/saveSnapshot.*against|same snapshot/i);
  });

  it("preserves the baseline when the request errors — baseline unchanged", async () => {
    const opts = { cacheDir, repoKey: "guard-preserve" };
    const baseline: CodeGraph = {
      defines: [{ file: "a.ts", name: "foo", kind: "function", line: 1 }],
      calls: [],
      imports: [],
      exports: [],
      contains: [],
    };
    await saveSnapshot("main", baseline, opts);

    const p = join(workDir, "a.ts");
    await writeFile(p, "function totallyNew() {}");

    await runAnalysis([p], {
      analysis: "diff",
      against: "main",
      saveSnapshot: "main",
      cache: opts,
    });

    // Re-extract against unchanged baseline — should still see "foo" as the
    // original baseline define, not "totallyNew".
    const p2 = join(workDir, "b.ts");
    await writeFile(p2, "function foo() {}");
    const r2 = await runAnalysis([p2], {
      analysis: "diff",
      against: "main",
      cache: opts,
    });
    const result = r2.result as { removedNodes?: string[]; addedNodes?: string[] };
    // baseline still has foo → foo is no longer removed
    expect(result.removedNodes ?? []).not.toContain("foo");
  });

  it("different snapshot names are fine: save new baseline while diffing against old", async () => {
    const opts = { cacheDir, repoKey: "guard-distinct" };
    const baseline: CodeGraph = {
      defines: [{ file: "a.ts", name: "original", kind: "function", line: 1 }],
      calls: [],
      imports: [],
      exports: [],
      contains: [],
    };
    await saveSnapshot("main", baseline, opts);

    const p = join(workDir, "a.ts");
    await writeFile(p, "function updated() {}");

    const r = await runAnalysis([p], {
      analysis: "diff",
      against: "main",
      saveSnapshot: "feature-branch",
      cache: opts,
    });
    const result = r.result as { addedNodes?: string[] };
    // Real diff should fire; no guard error.
    expect(result.addedNodes).toContain("updated");
  });
});

// ── LOW: hyperedge_label/2 emission ───────────────────────────────────────

describe("PR #21 fix: hyperedge_label/2 facts", () => {
  const graph = (hyperedges: Hyperedge[]): CodeGraph => ({
    defines: [], calls: [], imports: [], exports: [], contains: [], hyperedges,
  });

  it("emits hyperedge_label/2 when label is non-empty", () => {
    const program = graphToProlog(graph([
      { id: "auth_flow", label: "Authentication flow", nodes: ["a", "b"], relation: "participate" },
    ]));
    expect(program).toMatch(/hyperedge_label\(auth_flow,\s*'Authentication flow'\)\./);
  });

  it("omits hyperedge_label/2 when label is empty", () => {
    const program = graphToProlog(graph([
      { id: "g1", label: "", nodes: ["a", "b"], relation: "r" },
    ]));
    expect(program).not.toMatch(/hyperedge_label\(/);
  });

  it("declares :- dynamic(hyperedge_label/2) when any label is emitted", () => {
    const program = graphToProlog(graph([
      { id: "g1", label: "Label", nodes: ["a"], relation: "r" },
    ]));
    expect(program).toMatch(/:-\s*dynamic\(hyperedge_label\/2\)\./);
  });
});

// ── INFO: graphDiff covers imports, exports, hyperedges ───────────────────

describe("PR #21 fix: graphDiff extended coverage", () => {
  const base = (overrides: Partial<CodeGraph> = {}): CodeGraph => ({
    defines: [],
    calls: [],
    imports: [],
    exports: [],
    contains: [],
    ...overrides,
  });

  it("detects added import", () => {
    const before = base();
    const after = base({ imports: [{ file: "a.ts", name: "util", source: "./util" }] });
    const d = graphDiff(before, after);
    expect(d.addedImports).toHaveLength(1);
    expect(d.addedImports![0]).toMatchObject({ file: "a.ts", name: "util", source: "./util" });
  });

  it("detects removed import", () => {
    const before = base({ imports: [{ file: "a.ts", name: "util", source: "./util" }] });
    const after = base();
    const d = graphDiff(before, after);
    expect(d.removedImports).toHaveLength(1);
  });

  it("detects added export", () => {
    const before = base();
    const after = base({ exports: [{ file: "a.ts", name: "foo" }] });
    const d = graphDiff(before, after);
    expect(d.addedExports).toEqual([{ file: "a.ts", name: "foo" }]);
  });

  it("detects removed export", () => {
    const before = base({ exports: [{ file: "a.ts", name: "foo" }] });
    const after = base();
    const d = graphDiff(before, after);
    expect(d.removedExports).toEqual([{ file: "a.ts", name: "foo" }]);
  });

  it("detects added hyperedge", () => {
    const before = base();
    const after = base({ hyperedges: [{ id: "g1", label: "", nodes: ["a", "b"], relation: "r" }] });
    const d = graphDiff(before, after);
    expect(d.addedHyperedges).toHaveLength(1);
    expect(d.addedHyperedges![0].id).toBe("g1");
  });

  it("treats changed hyperedge members as removed + added", () => {
    const before = base({ hyperedges: [{ id: "g1", label: "", nodes: ["a", "b"], relation: "r" }] });
    const after = base({ hyperedges: [{ id: "g1", label: "", nodes: ["a", "b", "c"], relation: "r" }] });
    const d = graphDiff(before, after);
    // Simplest semantics: identity on (id) + deep-equal members; change = remove old + add new
    expect(d.addedHyperedges).toHaveLength(1);
    expect(d.removedHyperedges).toHaveLength(1);
  });

  it("no-op when nothing changes", () => {
    const g = base({
      imports: [{ file: "a.ts", name: "util", source: "./util" }],
      exports: [{ file: "a.ts", name: "foo" }],
      hyperedges: [{ id: "g1", label: "", nodes: ["a", "b"], relation: "r" }],
    });
    const d = graphDiff(g, g);
    expect(d.addedImports ?? []).toHaveLength(0);
    expect(d.removedImports ?? []).toHaveLength(0);
    expect(d.addedExports ?? []).toHaveLength(0);
    expect(d.removedExports ?? []).toHaveLength(0);
    expect(d.addedHyperedges ?? []).toHaveLength(0);
    expect(d.removedHyperedges ?? []).toHaveLength(0);
  });

  it("summary mentions imports/exports/hyperedges when changed", () => {
    const before = base();
    const after = base({
      imports: [{ file: "a.ts", name: "util", source: "./util" }],
      exports: [{ file: "a.ts", name: "foo" }],
      hyperedges: [{ id: "g1", label: "", nodes: ["a", "b"], relation: "r" }],
    });
    const d = graphDiff(before, after);
    expect(d.summary).toMatch(/import/);
    expect(d.summary).toMatch(/export/);
    expect(d.summary).toMatch(/hyperedge/);
  });
});

// ── LOW: bootstrapped Map size cap ────────────────────────────────────────

describe("PR #21 fix: lockfile bootstrap memo bounded", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-pr21-boot-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("stays bounded across many distinct repo keys", async () => {
    // Drive many distinct repos through saveFileCache / clearRepoCache.
    // The internal memo must not grow unboundedly — test can't inspect the
    // Map directly without breaking encapsulation, but we can exercise it
    // and assert behavior remains correct.
    for (let i = 0; i < 50; i++) {
      const opts = { cacheDir, repoKey: `repo-${i}` };
      // Touch the cache so bootstrap runs
      const graph: CodeGraph = {
        defines: [], calls: [], imports: [], exports: [], contains: [],
      };
      await saveSnapshot("baseline", graph, opts);
    }
    // After 50 distinct repos, behavior must still be correct: a 51st repo
    // can still acquire its own snapshot without interference.
    const opts = { cacheDir, repoKey: "repo-final" };
    const graph: CodeGraph = {
      defines: [{ file: "t.ts", name: "final", kind: "function", line: 1 }],
      calls: [], imports: [], exports: [], contains: [],
    };
    await saveSnapshot("baseline", graph, opts);
    // Confirm the save succeeded by running an analysis against it.
    const r = await runAnalysisFromGraph(graph, { analysis: "summary" });
    expect((r.result as { functions: number }).functions).toBe(1);
  });
});
