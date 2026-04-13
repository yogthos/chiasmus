import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalysis } from "../../src/graph/analyses.js";
import { saveSnapshot, listSnapshots } from "../../src/graph/cache.js";
import type { CodeGraph } from "../../src/graph/types.js";
import type { GraphDiffResult } from "../../src/graph/diff.js";

describe("runAnalysis: diff analysis", () => {
  let cacheDir: string;
  let workDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-diff-"));
    workDir = await mkdtemp(join(tmpdir(), "chiasmus-diff-src-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns error when against snapshot is missing", async () => {
    const p = join(workDir, "a.ts");
    await writeFile(p, "function foo() {}");
    const r = await runAnalysis([p], {
      analysis: "diff",
      against: "main",
      cache: { cacheDir, repoKey: "diff-test" },
    });
    const result = r.result as { error?: string };
    expect(result.error).toMatch(/snapshot/i);
  });

  it("computes diff against a saved snapshot", async () => {
    const opts = { cacheDir, repoKey: "diff-test" };
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
      cache: opts,
    });
    const result = r.result as GraphDiffResult;
    expect(result.addedNodes).toContain("bar");
    expect(result.addedEdges.some((e) => e.source === "foo" && e.target === "bar")).toBe(true);
  });

  it("saves a snapshot when saveSnapshot is supplied", async () => {
    const opts = { cacheDir, repoKey: "snap-save" };
    const p = join(workDir, "a.ts");
    await writeFile(p, "function foo() {}");

    await runAnalysis([p], {
      analysis: "summary",
      cache: opts,
      saveSnapshot: "main",
    });

    const snaps = await listSnapshots(opts);
    expect(snaps).toContain("main");
  });
});
