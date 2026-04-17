import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import {
  buildOverview,
  buildFileDetail,
  buildSymbolDetail,
  renderMap,
} from "../../src/graph/map.js";

describe("buildOverview", () => {
  it("returns summary counts and language list", async () => {
    const graph = await extractGraph([
      { path: "/repo/src/a.ts", content: "export function foo() {}" },
      { path: "/repo/src/nested/b.ts", content: "export function bar() {}" },
    ]);
    const overview = buildOverview(graph);
    expect(overview.summary.files).toBe(2);
    expect(overview.summary.languages).toContain("typescript");
    expect(overview.summary.exports).toBe(2);
  });

  it("produces one entry per file with export count and token estimate", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "export function x() {}\nexport function y() {}\n",
      },
    ]);
    const overview = buildOverview(graph);
    expect(overview.files).toHaveLength(1);
    const [f] = overview.files;
    expect(f.path).toBe("/repo/a.ts");
    expect(f.exportCount).toBe(2);
    expect(f.tokens).toBeGreaterThan(0);
  });

  it("counts interface-only exports that aren't in defines", async () => {
    // TS interface exports show up in graph.exports but NOT in graph.defines.
    // exportCount must still reflect the true count, and summary.exports must
    // agree with the sum of per-file counts.
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "export interface Foo { x: number; }\nexport function bar() {}\n",
      },
    ]);
    const overview = buildOverview(graph);
    const file = overview.files[0];
    expect(file.exportCount).toBe(2);
    expect(overview.summary.exports).toBe(2);
  });

  it("truncates topExports to maxExportsPerFile", async () => {
    const src = Array.from({ length: 12 }, (_, i) => `export function f${i}() {}`).join("\n");
    const graph = await extractGraph([{ path: "/repo/a.ts", content: src }]);
    const overview = buildOverview(graph, { maxExportsPerFile: 3 });
    const file = overview.files[0];
    expect(file.topExports).toHaveLength(3);
    expect(file.exportCount).toBe(12);
  });

  it("filters files via include glob", async () => {
    const graph = await extractGraph([
      { path: "/repo/src/a.ts", content: "export function a() {}" },
      { path: "/repo/tests/b.ts", content: "export function b() {}" },
    ]);
    const overview = buildOverview(graph, { include: "**/src/**" });
    const paths = overview.files.map((f) => f.path);
    expect(paths).toEqual(["/repo/src/a.ts"]);
  });

  it("builds a directory tree grouped by path segment", async () => {
    const graph = await extractGraph([
      { path: "/repo/src/a.ts", content: "export function a() {}" },
      { path: "/repo/src/nested/b.ts", content: "export function b() {}" },
    ]);
    const overview = buildOverview(graph);
    expect(overview.root).toBeDefined();
    const names = collectDirNames(overview.root);
    expect(names).toContain("src");
    expect(names).toContain("nested");
  });
});

describe("buildFileDetail", () => {
  it("returns exports with signatures and lines", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "export function foo(x: number, y: string): boolean { return true; }\n",
      },
    ]);
    const detail = buildFileDetail(graph, "/repo/a.ts");
    expect(detail).not.toBeNull();
    expect(detail!.exports).toHaveLength(1);
    expect(detail!.exports[0].name).toBe("foo");
    expect(detail!.exports[0].signature).toContain("x: number");
    expect(detail!.exports[0].line).toBeGreaterThan(0);
  });

  it("returns imports with sources", async () => {
    const graph = await extractGraph([
      { path: "/repo/a.ts", content: "import { x, y } from './b';\n" },
    ]);
    const detail = buildFileDetail(graph, "/repo/a.ts");
    const sources = detail!.imports.map((i) => i.source);
    expect(sources).toContain("./b");
  });

  it("returns null when the file isn't in the graph", async () => {
    const graph = await extractGraph([
      { path: "/repo/a.ts", content: "export function foo() {}" },
    ]);
    expect(buildFileDetail(graph, "/repo/missing.ts")).toBeNull();
  });
});

describe("buildSymbolDetail", () => {
  it("returns defining files, callers, and callees", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: `
          function top() { mid(); }
          function mid() { leaf(); }
          function leaf() {}
        `,
      },
    ]);
    const detail = buildSymbolDetail(graph, "mid");
    expect(detail.name).toBe("mid");
    expect(detail.defines[0].file).toBe("/repo/a.ts");
    expect(detail.callers).toContain("top");
    expect(detail.callees).toContain("leaf");
  });

  it("returns empty arrays for an unknown symbol", async () => {
    const graph = await extractGraph([
      { path: "/repo/a.ts", content: "function only() {}" },
    ]);
    const detail = buildSymbolDetail(graph, "missing");
    expect(detail.defines).toHaveLength(0);
    expect(detail.callers).toHaveLength(0);
    expect(detail.callees).toHaveLength(0);
  });
});

describe("renderMap", () => {
  it("renders markdown with summary header and file entries", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "/** Greets the world. */\nexport function greet() {}\n",
      },
    ]);
    const overview = buildOverview(graph);
    const md = renderMap(overview, "markdown");
    expect(md).toMatch(/Codebase overview/i);
    expect(md).toContain("/repo/a.ts");
    expect(md).toContain("greet");
  });

  it("renders valid JSON for overview", async () => {
    const graph = await extractGraph([
      { path: "/repo/a.ts", content: "export function foo() {}" },
    ]);
    const overview = buildOverview(graph);
    const json = renderMap(overview, "json");
    const parsed = JSON.parse(json);
    expect(parsed.summary.files).toBe(1);
  });

  it("renders file detail as markdown with exports section", async () => {
    const graph = await extractGraph([
      { path: "/repo/a.ts", content: "export function foo(x: number) {}" },
    ]);
    const detail = buildFileDetail(graph, "/repo/a.ts")!;
    const md = renderMap(detail, "markdown");
    expect(md).toContain("/repo/a.ts");
    expect(md).toMatch(/exports/i);
    expect(md).toContain("foo");
  });
});

describe("extractor: fileDoc + tokenEstimate + lineCount", () => {
  it("captures a leading JSDoc block as fileDoc", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "/**\n * Parses config from disk.\n */\nexport function load() {}\n",
      },
    ]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.ts");
    expect(fn?.fileDoc).toMatch(/Parses config/);
  });

  it("does NOT capture `//` line comments as fileDoc for TS/JS (usually license/shebang noise)", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "// Entry point.\n// Boots the server.\nexport function start() {}\n",
      },
    ]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.ts");
    expect(fn?.fileDoc).toBeUndefined();
  });

  it("does NOT capture license/copyright headers as fileDoc", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "/* Copyright 2025 Acme. Licensed under Apache 2.0. */\nexport function foo() {}\n",
      },
    ]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.ts");
    expect(fn?.fileDoc).toBeUndefined();
  });

  it("does NOT capture Python `#` comments without a docstring", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.py",
        content: "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\ndef foo():\n    pass\n",
      },
    ]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.py");
    expect(fn?.fileDoc).toBeUndefined();
  });

  it("captures Go `//` comments as fileDoc (idiomatic package doc)", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.go",
        content: "// Package foo wires routes to handlers.\npackage foo\n\nfunc Bar() {}\n",
      },
    ]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.go");
    expect(fn?.fileDoc).toMatch(/Package foo wires/);
  });

  it("captures a Python module docstring", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.py",
        content: '"""Loads config."""\n\ndef load():\n    pass\n',
      },
    ]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.py");
    expect(fn?.fileDoc).toMatch(/Loads config/);
  });

  it("computes tokenEstimate and lineCount from content", async () => {
    // Three logical lines: "xxxx", "yyyy", "zzzz\n" (trailing newline keeps
    // count at 3 — wc -l semantics). Length 351 → ~100 tokens at 3.5 cpt.
    const content = "x".repeat(115) + "\n" + "y".repeat(115) + "\n" + "z".repeat(115) + "\n";
    const graph = await extractGraph([{ path: "/repo/a.ts", content }]);
    const fn = graph.files?.find((f) => f.path === "/repo/a.ts");
    expect(fn?.tokenEstimate).toBeGreaterThan(90);
    expect(fn?.tokenEstimate).toBeLessThan(120);
    expect(fn?.lineCount).toBe(3);
  });
});

describe("extractor: signatures on exported defines", () => {
  it("captures TypeScript function signatures", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.ts",
        content: "export function foo(x: number, y: string): boolean { return true; }",
      },
    ]);
    const foo = graph.defines.find((d) => d.name === "foo");
    expect(foo?.signature).toContain("x: number");
    expect(foo?.signature).toContain("y: string");
  });

  it("captures Python function signatures", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.py",
        content: "def foo(x: int, y: str) -> bool:\n    return True\n",
      },
    ]);
    const foo = graph.defines.find((d) => d.name === "foo");
    expect(foo?.signature).toMatch(/x:\s*int/);
  });

  it("captures Go function signatures", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.go",
        content: "package p\nfunc Foo(x int, y string) bool { return true }\n",
      },
    ]);
    const foo = graph.defines.find((d) => d.name === "Foo");
    expect(foo?.signature).toMatch(/x\s+int/);
  });

  it("captures Clojure defn arglists as signature", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/a.clj",
        content: "(ns app.core)\n(defn greet [name]\n  (println \"hi\" name))\n",
      },
    ]);
    const greet = graph.defines.find((d) => d.name.endsWith("/greet") || d.name === "greet");
    expect(greet?.signature).toContain("[name]");
  });

  it("captures Clojure defprotocol method arglists as signature", async () => {
    const graph = await extractGraph([
      {
        path: "/repo/proto.clj",
        content: "(ns app.proto)\n(defprotocol Greet\n  (say-hi [this name])\n  (say-bye [this name farewell]))\n",
      },
    ]);
    const sayHi = graph.defines.find((d) => d.name.endsWith("say-hi") || d.name === "say-hi");
    expect(sayHi?.signature).toContain("[this name]");
  });
});

function collectDirNames(node: { name: string; dirs: any[] }): string[] {
  const names: string[] = [node.name];
  for (const d of node.dirs) names.push(...collectDirNames(d));
  return names;
}
