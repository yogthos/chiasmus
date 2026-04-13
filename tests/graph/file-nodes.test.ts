import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import { graphToProlog } from "../../src/graph/facts.js";

describe("file nodes", () => {
  it("extractGraph emits one FileNode per input file with language", async () => {
    const graph = await extractGraph([
      { path: "/abs/a.ts", content: "function a() {}" },
      { path: "/abs/b.clj", content: "(defn b [] 1)" },
    ]);
    expect(graph.files).toBeDefined();
    const files = graph.files ?? [];
    const pathsWithLang = files.map((f) => `${f.path}:${f.language}`).sort();
    expect(pathsWithLang).toContain("/abs/a.ts:typescript");
    // Clojure detection keys on .clj extension.
    expect(pathsWithLang.some((p) => p.startsWith("/abs/b.clj:"))).toBe(true);
  });

  it("skips files in unsupported languages", async () => {
    const graph = await extractGraph([
      { path: "/abs/a.ts", content: "function a() {}" },
      { path: "/abs/readme.txt", content: "not code" },
    ]);
    const files = graph.files ?? [];
    const paths = files.map((f) => f.path);
    expect(paths).toContain("/abs/a.ts");
    expect(paths).not.toContain("/abs/readme.txt");
  });

  it("graphToProlog emits file/2 facts", async () => {
    const graph = await extractGraph([
      { path: "/abs/a.ts", content: "function a() {}" },
    ]);
    const program = graphToProlog(graph);
    // Expect a fact of form file('/abs/a.ts', typescript).
    expect(program).toMatch(/file\('\/abs\/a\.ts',\s*typescript\)\./);
  });

  it("does not emit duplicate FileNodes for the same path", async () => {
    const graph = await extractGraph([
      { path: "/abs/a.ts", content: "function a() {}" },
      { path: "/abs/a.ts", content: "function a() {}" },
    ]);
    const files = graph.files ?? [];
    const paths = files.map((f) => f.path);
    const unique = new Set(paths);
    expect(paths.length).toBe(unique.size);
  });
});
