import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { parseSourceAsync } from "../../src/graph/parser.js";

// Same module instance parser.ts loads (shared CJS require cache).
const { Parser, Language } = createRequire(import.meta.url)("web-tree-sitter");

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * initWasm() and each grammar's Language.load() are shared promises. A failed
 * one must be forgotten, or every later parse on the thread would reuse the
 * rejection. The first test needs a cold thread: it must run before anything
 * else in this file initialises web-tree-sitter.
 */
describe("web-tree-sitter init failures", () => {
  it("retries Parser.init() after a failed init", async () => {
    const init = vi.spyOn(Parser, "init").mockRejectedValueOnce(new Error("init failed"));
    expect(await parseSourceAsync("(ns a)\n(defn f [x] x)\n", "/virtual/a.clj")).toBeNull();

    const tree = await parseSourceAsync("(ns a)\n(defn f [x] x)\n", "/virtual/a.clj");
    expect(tree?.rootNode.hasError).toBe(false);
    tree.delete();
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("retries Language.load() after a failed grammar load", async () => {
    // Scheme: the Clojure grammar above is already loaded and cached.
    const load = vi.spyOn(Language, "load").mockRejectedValueOnce(new Error("load failed"));
    expect(await parseSourceAsync("(define (f x) x)\n", "/virtual/a.scm")).toBeNull();

    const tree = await parseSourceAsync("(define (f x) x)\n", "/virtual/a.scm");
    expect(tree?.rootNode.hasError).toBe(false);
    tree.delete();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
