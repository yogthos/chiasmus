import { describe, it, expect } from "vitest";
import { parseSourceAsync } from "../../src/graph/parser.js";

/**
 * Concurrent parses on a cold thread (extractGraph used to start a whole
 * batch at once; concurrent graph calls on one thread still do) each ran
 * web-tree-sitter's Parser.init() and Language.load() themselves: one
 * runtime instance and one grammar instance per file, and grammars bound
 * to whichever runtime instance they loaded into. Init and grammar loads
 * must be shared by concurrent callers.
 *
 * This file must stay the only WASM user in its test process: the counts
 * below assume nothing was loaded before.
 */
describe("web-tree-sitter initialisation on a cold thread", () => {
  it("instantiates the runtime once and each grammar file once for concurrent parses", async () => {
    const wasm = (globalThis as any).WebAssembly;
    const original = wasm.instantiate;
    let instantiations = 0;
    wasm.instantiate = (...args: unknown[]) => {
      instantiations++;
      return original.apply(wasm, args);
    };
    try {
      const files: Array<{ path: string; content: string }> = [];
      for (let i = 0; i < 8; i++) {
        files.push({ path: `/virtual/ns${i}.clj`, content: `(ns ns${i})\n(defn f${i} [x] (g${i} x))\n` });
        files.push({ path: `/virtual/s${i}.scm`, content: `(define (f${i} x) (g${i} x))\n` });
        // Racket reuses the Scheme grammar file.
        files.push({ path: `/virtual/r${i}.rkt`, content: `(define (f${i} x) (g${i} x))\n` });
      }
      const trees = await Promise.all(files.map((f) => parseSourceAsync(f.content, f.path)));
      for (const tree of trees) {
        expect(tree?.rootNode.hasError).toBe(false);
        tree.delete();
      }
      // Runtime + clojure grammar + scheme grammar (shared with racket).
      expect(instantiations).toBe(3);
    } finally {
      wasm.instantiate = original;
    }
  });
});
