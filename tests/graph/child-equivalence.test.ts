import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGraphTool, shutdownGraphChild, type GraphTool } from "../../src/graph/child-pool.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFilesUnder(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

/** One language per file, native and WASM grammars, calling across files. */
const CORPUS: Record<string, string> = {
  "api/server.ts": `import { query } from "../db/db";
import { Repo } from "./repo";
/** HTTP entry. */
export function handleRequest(id: number) { validate(id); return new Repo().load(id) + query(id); }
function validate(id: number) { if (id < 0) audit(id); }
export function audit(id: number) { return query(id); }
`,
  "api/repo.ts": `import { query } from "../db/db";
export class Base { load(id: number) { return query(id); } }
export class Repo extends Base { save(id: number) { this.load(id); return query(id); } }
`,
  "db/db.ts": `export function query(id: number): number { return connect() + id; }
function connect(): number { return pool(); }
function pool(): number { return connect(); }
export function unused() {}
`,
  "web/app.js": `import { handleRequest } from "../api/server";
export function main() { return handleRequest(1) + render(); }
function render() { return 0; }
`,
  "tools/report.py": `"""Report generator."""
def build():
    rows = fetch()
    return render(rows)

def fetch():
    return []

def render(rows):
    return len(rows)
`,
  "svc/svc.go": `package svc

func Serve() int { return handle() + Serve2() }
func handle() int { return 1 }
func Serve2() int { return handle() }
`,
  "core/lib.rs": `/// Core math.
pub fn total(xs: &[i32]) -> i32 { xs.iter().map(|x| square(*x)).sum() }
fn square(x: i32) -> i32 { x * x }
`,
  "clj/app.clj": `(ns app.core
  (:require [app.util :as util]))
(defn run [x] (util/twice (step x)))
(defn step [x] (inc x))
`,
  "clj/util.clj": `(ns app.util)
(defn twice [x] (* 2 x))
`,
  "lisp/geo.scm": `(define (area r) (* (sq r) 3))
(define (sq x) (* x x))
`,
  "lisp/pkg.lisp": `(in-package :geo)
(defun perimeter (r) (* 2 (radius-of r)))
(defun radius-of (r) r)
`,
};

describe("graph tools: child process output is byte-identical to inline (CHIASMUS_GRAPH_WORKER=off)", () => {
  let root: string;
  let corpus: string[];
  let prevCacheDir: string | undefined;

  function text(r: { content: unknown }): string {
    return (r.content as Array<{ text: string }>)[0].text;
  }

  async function inline(tool: GraphTool, args: Record<string, unknown>): Promise<string> {
    const prev = process.env.CHIASMUS_GRAPH_WORKER;
    process.env.CHIASMUS_GRAPH_WORKER = "off";
    try {
      return text(await runGraphTool({ tool, args }));
    } finally {
      if (prev === undefined) delete process.env.CHIASMUS_GRAPH_WORKER;
      else process.env.CHIASMUS_GRAPH_WORKER = prev;
    }
  }

  async function child(tool: GraphTool, args: Record<string, unknown>): Promise<string> {
    return text(await runGraphTool({ tool, args }));
  }

  async function expectSame(tool: GraphTool, args: Record<string, unknown>): Promise<string> {
    const viaChild = await child(tool, args);
    expect(viaChild).toBe(await inline(tool, args));
    return viaChild;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-child-equiv-"));
    prevCacheDir = process.env.CHIASMUS_CACHE_DIR;
    process.env.CHIASMUS_CACHE_DIR = join(root, "cache");
    corpus = [];
    for (const [rel, src] of Object.entries(CORPUS)) {
      const p = join(root, "repo", rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, src);
      corpus.push(p);
    }
  });

  afterAll(async () => {
    try {
      await shutdownGraphChild();
    } finally {
      if (prevCacheDir === undefined) delete process.env.CHIASMUS_CACHE_DIR;
      else process.env.CHIASMUS_CACHE_DIR = prevCacheDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("every chiasmus_graph analysis over a multi-language corpus", async () => {
    const requests: Array<Record<string, unknown>> = [
      { analysis: "summary" },
      { analysis: "callers", target: "query" },
      { analysis: "callees", target: "handleRequest" },
      { analysis: "reachability", from: "main", to: "pool" },
      { analysis: "path", from: "main", to: "connect" },
      { analysis: "impact", target: "query" },
      { analysis: "dead-code" },
      { analysis: "dead-code", entry_points: ["main", "build"] },
      { analysis: "cycles" },
      { analysis: "layer-violation" },
      { analysis: "communities" },
      { analysis: "hubs" },
      { analysis: "bridges" },
      { analysis: "surprises" },
      { analysis: "entry-points" },
      { analysis: "facts" },
      { analysis: "facts", include_insights: true },
    ];
    for (const req of requests) {
      const out = await expectSame("chiasmus_graph", { files: corpus, ...req });
      expect(JSON.parse(out).error, JSON.stringify(req)).toBeUndefined();
    }
    // Every language, native and WASM grammars alike, contributed definitions.
    const facts = JSON.parse(await child("chiasmus_graph", { files: corpus, analysis: "facts" })).result as string;
    for (const name of ["handleRequest", "'Repo'", "main", "fetch", "Serve", "square", "twice", "area", "perimeter"]) {
      expect(facts).toMatch(new RegExp(`defines\\([^\\n]*${name}`));
    }
  });

  it("every chiasmus_map mode over a multi-language corpus", async () => {
    const requests: Array<Record<string, unknown>> = [
      {},
      { format: "json" },
      { include: ["**/api/**"], max_exports: 1 },
      { mode: "file", path: corpus[0] },
      { mode: "file", path: corpus[0], format: "json" },
      { mode: "symbol", name: "query" },
      { mode: "symbol", name: "twice", format: "json" },
    ];
    for (const req of requests) {
      const out = await expectSame("chiasmus_map", { files: corpus, ...req });
      expect(out).not.toMatch(/^\{"error"/);
    }
  });

  it("this repository's src/: the full graph (facts), entry points and maps", async () => {
    const files = tsFilesUnder(SRC);
    expect(files.length).toBeGreaterThan(20);
    for (const req of [{ analysis: "facts" }, { analysis: "entry-points" }]) {
      const out = await expectSame("chiasmus_graph", { files, ...req });
      expect(JSON.parse(out).error).toBeUndefined();
    }
    await expectSame("chiasmus_map", { files });
    await expectSame("chiasmus_map", { files, format: "json" });
  }, 30_000);

  it("shares the per-file cache and snapshots across modes", async () => {
    const uncached = await inline("chiasmus_graph", { files: corpus, analysis: "facts" });
    // Cold in the child (it writes the cache and the snapshot)...
    expect(await child("chiasmus_graph", { files: corpus, analysis: "facts", cache: true, save_snapshot: "base-child" }))
      .toBe(uncached);
    // ...warm inline, reading what the child wrote.
    expect(await inline("chiasmus_graph", { files: corpus, analysis: "facts", cache: true })).toBe(uncached);
    expect(JSON.parse(await inline("chiasmus_graph", {
      files: corpus, analysis: "summary", cache: true, save_snapshot: "base-inline",
    })).error).toBeUndefined();

    await writeFile(corpus[2], `${CORPUS["db/db.ts"]}export function added() { return query(1); }\n`);
    for (const against of ["base-child", "base-inline"]) {
      const diff = await expectSame("chiasmus_graph", { files: corpus, analysis: "diff", against, cache: true });
      expect(JSON.parse(diff).result.addedNodes).toContain("added");
    }
  });
});
