#!/usr/bin/env tsx
/**
 * Benchmark the extraction cache: cold vs warm, partial invalidation,
 * on-disk footprint. Uses chiasmus's own src/ as the corpus.
 *
 * Run: npx tsx benchmark/cache-bench.mts
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { extractGraph } from "../src/graph/extractor.js";
import { resolveCachePaths } from "../src/graph/cache.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CORPUS = join(REPO_ROOT, "src");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walkTsFiles(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
  return { result, ms };
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) total += dirSize(p);
      else total += s.size;
    }
  } catch { /* missing */ }
  return total;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const paths = walkTsFiles(CORPUS);
  console.log(`Corpus: ${paths.length} TypeScript files under ${CORPUS}`);

  const files = paths.map((path) => ({ path, content: readFileSync(path, "utf-8") }));
  const totalBytes = files.reduce((a, f) => a + f.content.length, 0);
  console.log(`Total source: ${fmtBytes(totalBytes)}`);

  const cacheDir = mkdtempSync(join(tmpdir(), "chiasmus-bench-"));
  const cacheOpts = { cacheDir, repoKey: "bench" };
  console.log(`Cache dir: ${cacheDir}\n`);

  try {
    // ── Cold, no cache ──────────────────────────────────────────────
    console.log("— Cold, cache disabled —");
    const noCacheRuns: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { ms } = await timed(`run ${i + 1}`, () => extractGraph(files));
      noCacheRuns.push(ms);
    }
    const noCacheMedian = [...noCacheRuns].sort((a, b) => a - b)[1];

    // ── Cold, cache enabled (populates cache) ────────────────────────
    console.log("\n— Cold, cache enabled (populates) —");
    const cold = await timed("run", () => extractGraph(files, { cache: cacheOpts }));

    // ── Warm, cache enabled (all hits) ───────────────────────────────
    console.log("\n— Warm, cache enabled (100% hits) —");
    const warmRuns: Array<{ result: any; ms: number }> = [];
    for (let i = 0; i < 3; i++) {
      warmRuns.push(await timed(`run ${i + 1}`, () => extractGraph(files, { cache: cacheOpts })));
    }
    const warmMedian = [...warmRuns.map((r) => r.ms)].sort((a, b) => a - b)[1];

    // Correctness: warm result must equal cold result.
    const coldNames = [...cold.result.defines].map((d: any) => d.name).sort();
    const warmNames = [...warmRuns[0].result.defines].map((d: any) => d.name).sort();
    const sameDefines = JSON.stringify(coldNames) === JSON.stringify(warmNames);
    const coldEdges = cold.result.calls.length;
    const warmEdges = warmRuns[0].result.calls.length;
    console.log(`\n  correctness: ${sameDefines && coldEdges === warmEdges ? "PASS" : "FAIL"} (defines: ${coldNames.length} vs ${warmNames.length}, edges: ${coldEdges} vs ${warmEdges})`);

    // ── Partial invalidation: change 1 file, extract ─────────────────
    console.log("\n— 1 file changed, rest cached —");
    const mutated = files.map((f, i) => (i === 0 ? { ...f, content: f.content + "\n// tweak\n" } : f));
    const partial = await timed("run", () => extractGraph(mutated, { cache: cacheOpts }));

    // ── Disk footprint ──────────────────────────────────────────────
    const { filesDir } = resolveCachePaths(cacheOpts);
    const cacheBytes = dirSize(filesDir);
    const repoDirBytes = dirSize(join(cacheDir, "bench"));

    // ── Summary ──────────────────────────────────────────────────────
    console.log("\n=== Summary ===");
    console.log(`Cold (no cache), median : ${noCacheMedian.toFixed(1)} ms`);
    console.log(`Cold (cache populate)   : ${cold.ms.toFixed(1)} ms (populate overhead: ${(cold.ms - noCacheMedian).toFixed(1)} ms, ${(((cold.ms - noCacheMedian) / noCacheMedian) * 100).toFixed(0)}%)`);
    console.log(`Warm (100% hit), median : ${warmMedian.toFixed(1)} ms`);
    console.log(`Speedup warm / cold     : ${(noCacheMedian / warmMedian).toFixed(1)}x`);
    console.log(`Partial (1/${files.length} changed)   : ${partial.ms.toFixed(1)} ms`);
    console.log(`Cache on disk (files/)  : ${fmtBytes(cacheBytes)}`);
    console.log(`Cache on disk (repoDir) : ${fmtBytes(repoDirBytes)}`);
    console.log(`Compression ratio       : ${(cacheBytes / totalBytes).toFixed(2)}x source size`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
