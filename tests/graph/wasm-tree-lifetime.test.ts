import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { extractGraph } from "../../src/graph/extractor.js";

// Same module instance parser.ts loads (shared CJS require cache).
const { Parser } = createRequire(import.meta.url)("web-tree-sitter");

/**
 * WASM-grammar files parse after an await. If extractGraph started every
 * file at once, the whole batch would be parsed before the first tree was
 * walked and freed, and every tree would sit in web-tree-sitter's WASM heap
 * together (the wasm32 heap tops out at 4 GB).
 */
describe("WASM tree lifetime during extractGraph", () => {
  it("walks and frees each tree before parsing the next file", async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `/virtual/ns${i}.clj`,
      content: `(ns ns${i})\n(defn f${i} [x] (g${i} x))\n(defn g${i} [x] x)\n`,
    }));
    // Warm the grammar, as on a thread that has already extracted a batch:
    // cold, the grammar load's I/O can stagger the parses by luck.
    await extractGraph(files.slice(0, 1));
    const parse = Parser.prototype.parse;
    let live = 0;
    let maxLive = 0;
    Parser.prototype.parse = function (this: unknown, ...args: unknown[]) {
      const tree = parse.apply(this, args);
      maxLive = Math.max(maxLive, ++live);
      const del = tree.delete.bind(tree);
      tree.delete = () => {
        live--;
        del();
      };
      return tree;
    };
    try {
      const graph = await extractGraph(files);
      expect(graph.defines).toHaveLength(60);
    } finally {
      Parser.prototype.parse = parse;
    }
    expect(live).toBe(0);
    expect(maxLive).toBe(1);
  });
});
