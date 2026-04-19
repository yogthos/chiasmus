import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGraph } from "../../src/graph/extractor.js";
import { MockEmbeddingAdapter } from "../../src/llm/mock.js";
import { buildSearchCorpus, runSearch } from "../../src/search/engine.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chiasmus-search-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = join(dir, rel);
  const parent = full.substring(0, full.lastIndexOf("/"));
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("buildSearchCorpus", () => {
  it("builds one corpus entry per function/method define", async () => {
    const a = write(
      "a.ts",
      `/** Adds two numbers. */
       export function add(x: number, y: number): number { return x + y; }
       /** Subtracts. */
       export function sub(x: number, y: number): number { return x - y; }`,
    );
    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );
    const files = new Map([[a, readFileSync(a, "utf8")]]);
    const corpus = buildSearchCorpus(graph, files);
    const names = corpus.map((c) => c.name);
    expect(names).toContain("add");
    expect(names).toContain("sub");
    // Each entry has text combining signature + preamble
    const addEntry = corpus.find((c) => c.name === "add");
    expect(addEntry).toBeDefined();
    expect(addEntry!.text).toContain("add");
  });

  it("text includes the function signature when available", async () => {
    const a = write(
      "a.ts",
      `export function doWork(arg: number): boolean { return arg > 0; }`,
    );
    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );
    const files = new Map([[a, readFileSync(a, "utf8")]]);
    const corpus = buildSearchCorpus(graph, files);
    const e = corpus.find((c) => c.name === "doWork");
    expect(e).toBeDefined();
    expect(e!.text).toContain("arg: number");
  });
});

describe("runSearch (MockEmbeddingAdapter)", () => {
  it("returns topK results ranked by similarity", async () => {
    const a = write(
      "a.ts",
      `export function fetchUser() {}
       export function renderPage() {}
       export function computeHash() {}`,
    );
    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );
    const files = new Map([[a, readFileSync(a, "utf8")]]);
    const corpus = buildSearchCorpus(graph, files);

    const adapter = new MockEmbeddingAdapter({ dimension: 8 });
    // Embed the corpus first so the hash-based mock puts them in.
    const results = await runSearch({
      query: "fetchUser",
      corpus,
      adapter,
      topK: 2,
    });
    expect(results).toHaveLength(2);
    // Deterministic mock gives a stable top-1 — should contain the query literal
    expect(results[0].name).toBe("fetchUser");
  });

  it("empty corpus returns empty results", async () => {
    const adapter = new MockEmbeddingAdapter({ dimension: 4 });
    const results = await runSearch({ query: "x", corpus: [], adapter, topK: 5 });
    expect(results).toEqual([]);
  });

  it("honors topK smaller than corpus size", async () => {
    const a = write(
      "a.ts",
      `function f1() {} function f2() {} function f3() {} function f4() {}`,
    );
    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );
    const files = new Map([[a, readFileSync(a, "utf8")]]);
    const corpus = buildSearchCorpus(graph, files);

    const adapter = new MockEmbeddingAdapter({ dimension: 8 });
    const results = await runSearch({
      query: "f2",
      corpus,
      adapter,
      topK: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("each result carries file path, line, and signature from the graph", async () => {
    const a = write(
      "a.ts",
      `export function runTask(id: number): void {}`,
    );
    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );
    const files = new Map([[a, readFileSync(a, "utf8")]]);
    const corpus = buildSearchCorpus(graph, files);

    const adapter = new MockEmbeddingAdapter({ dimension: 4 });
    const [hit] = await runSearch({ query: "runTask", corpus, adapter, topK: 1 });
    expect(hit.file).toBe(a);
    expect(hit.line).toBeGreaterThan(0);
    expect(hit.signature).toContain("id: number");
  });
});
