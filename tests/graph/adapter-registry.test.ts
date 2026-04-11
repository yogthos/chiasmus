import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAdapter,
  getAdapter,
  getAdapterForExt,
  getAdapterExtensions,
  clearAdapters,
  discoverAdapters,
} from "../../src/graph/adapter-registry.js";
import { extractGraph } from "../../src/graph/extractor.js";
import { getLanguageForFile, getSupportedExtensions } from "../../src/graph/parser.js";
import type { LanguageAdapter, CodeGraph } from "../../src/graph/types.js";

/** A minimal adapter that reuses the JS grammar but extracts only function names */
function makeTestAdapter(overrides?: Partial<LanguageAdapter>): LanguageAdapter {
  return {
    language: "test-lang",
    extensions: [".tl"],
    grammar: { package: "tree-sitter-javascript" },
    extract(rootNode, filePath): CodeGraph {
      const defines: CodeGraph["defines"] = [];
      const calls: CodeGraph["calls"] = [];
      // Walk top-level function_declarations
      for (let i = 0; i < rootNode.childCount; i++) {
        const child = rootNode.child(i);
        if (child.type === "function_declaration") {
          const name = child.childForFieldName("name")?.text;
          if (name) {
            defines.push({ file: filePath, name, kind: "function", line: child.startPosition.row + 1 });
          }
        }
      }
      // Walk for call_expression inside functions
      for (let i = 0; i < rootNode.childCount; i++) {
        const child = rootNode.child(i);
        if (child.type === "function_declaration") {
          const callerName = child.childForFieldName("name")?.text;
          if (callerName) {
            walkCalls(child, callerName, calls, new Set());
          }
        }
      }
      return { defines, calls, imports: [], exports: [], contains: [] };
    },
    ...overrides,
  };
}

function walkCalls(node: any, caller: string, calls: CodeGraph["calls"], seen: Set<string>): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "call_expression") {
      const fn = child.childForFieldName("function");
      if (fn?.type === "identifier") {
        const key = `${caller}->${fn.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push({ caller, callee: fn.text });
        }
      }
    }
    walkCalls(child, caller, calls, seen);
  }
}

describe("adapter-registry", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("registerAdapter + getAdapter round-trips", () => {
    const adapter = makeTestAdapter();
    registerAdapter(adapter);

    expect(getAdapter("test-lang")).toBe(adapter);
    expect(getAdapter("nonexistent")).toBeNull();
  });

  it("getAdapterForExt resolves by extension", () => {
    const adapter = makeTestAdapter();
    registerAdapter(adapter);

    expect(getAdapterForExt(".tl")).toBe(adapter);
    expect(getAdapterForExt(".TL")).toBe(adapter); // case-insensitive
    expect(getAdapterForExt(".xyz")).toBeNull();
  });

  it("getAdapterExtensions includes registered extensions", () => {
    registerAdapter(makeTestAdapter());
    expect(getAdapterExtensions()).toContain(".tl");
  });

  it("normalizes extensions without leading dot", () => {
    registerAdapter(makeTestAdapter({ extensions: ["tl2"] }));
    expect(getAdapterForExt(".tl2")).not.toBeNull();
  });

  it("clearAdapters removes all registrations", () => {
    registerAdapter(makeTestAdapter());
    expect(getAdapter("test-lang")).not.toBeNull();

    clearAdapters();
    expect(getAdapter("test-lang")).toBeNull();
    expect(getAdapterExtensions()).toHaveLength(0);
  });
});

describe("adapter integration with parser", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("getLanguageForFile resolves adapter extensions", () => {
    registerAdapter(makeTestAdapter());
    expect(getLanguageForFile("foo.tl")).toBe("test-lang");
  });

  it("built-in extensions take precedence over adapters", () => {
    // Register an adapter that claims .ts
    registerAdapter(makeTestAdapter({ language: "fake-ts", extensions: [".ts"] }));
    // Built-in should win
    expect(getLanguageForFile("foo.ts")).toBe("typescript");
  });

  it("getSupportedExtensions includes adapter extensions", () => {
    registerAdapter(makeTestAdapter());
    const exts = getSupportedExtensions();
    expect(exts).toContain(".tl");
    expect(exts).toContain(".ts"); // built-in still present
  });
});

describe("adapter integration with extractor", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("dispatches to adapter.extract for registered language", async () => {
    registerAdapter(makeTestAdapter());

    const graph = await extractGraph([{
      path: "test.tl",
      // This is JS syntax — the adapter uses the JS grammar
      content: `
        function hello() { world(); }
        function world() {}
      `,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("hello");
    expect(names).toContain("world");

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("hello->world");
  });

  it("deduplicates calls across adapter-extracted files", async () => {
    registerAdapter(makeTestAdapter());

    const graph = await extractGraph([
      { path: "a.tl", content: `function a() { shared(); }` },
      { path: "b.tl", content: `function b() { shared(); }` },
    ]);

    // Each file produces its own caller->shared, both should appear
    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("a->shared");
    expect(callPairs).toContain("b->shared");
  });

  it("does not affect built-in languages", async () => {
    registerAdapter(makeTestAdapter());

    // JS files should still use the built-in walker
    const graph = await extractGraph([{
      path: "test.js",
      content: `
        function foo() { bar(); }
        function bar() {}
      `,
    }]);

    expect(graph.defines.map((d) => d.name)).toContain("foo");
    expect(graph.calls.map((c) => `${c.caller}->${c.callee}`)).toContain("foo->bar");
  });
});

describe("discoverAdapters", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("does not throw when no chiasmus-adapter-* packages exist", async () => {
    await expect(discoverAdapters()).resolves.not.toThrow();
  });

  it("is idempotent (only runs once)", async () => {
    await discoverAdapters();
    // Register an adapter after discovery
    registerAdapter(makeTestAdapter());
    // Running again should not clear the manually registered adapter
    await discoverAdapters();
    expect(getAdapter("test-lang")).not.toBeNull();
  });

  it("concurrent callers share the same in-flight discovery promise", async () => {
    // Regression: the original implementation set a boolean flag and then
    // continued asynchronously, so a second caller invoked while the first
    // was still scanning would return immediately before scanning completed.
    // Both calls must resolve to the same promise object (same instance)
    // so every caller awaits the single in-flight scan.
    const p1 = discoverAdapters();
    const p2 = discoverAdapters();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
  });
});

describe("searchPaths", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("adapter with searchPaths is accepted by registerAdapter", () => {
    const adapter = makeTestAdapter({
      searchPaths: ["/nonexistent/path"],
    });
    registerAdapter(adapter);
    expect(getAdapter("test-lang")).toBe(adapter);
    expect(adapter.searchPaths).toEqual(["/nonexistent/path"]);
  });
});
