import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";

describe("extractGraph", () => {
  it("extracts function declarations", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `
        function handleRequest() {}
        function validate() {}
      `,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("handleRequest");
    expect(names).toContain("validate");
    expect(graph.defines.every((d) => d.kind === "function")).toBe(true);
    expect(graph.defines.every((d) => d.file === "test.ts")).toBe(true);
  });

  it("extracts arrow functions assigned to const", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `const processData = (x: number) => { return x; };`,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("processData");
  });

  it("extracts call relationships", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `
        function a() { b(); c(); }
        function b() { c(); }
        function c() {}
      `,
    }]);

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("a->b");
    expect(callPairs).toContain("a->c");
    expect(callPairs).toContain("b->c");
  });

  it("extracts method calls from member expressions", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `
        function foo() { this.bar(); obj.baz(); }
        function bar() {}
        function baz() {}
      `,
    }]);

    const callees = graph.calls.filter((c) => c.caller === "foo").map((c) => c.callee);
    expect(callees).toContain("bar");
    expect(callees).toContain("baz");
  });

  it("extracts class with methods and produces defines + contains", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `
        class MyService {
          handleRequest() {}
          validate() {}
        }
      `,
    }]);

    const classDefine = graph.defines.find((d) => d.name === "MyService");
    expect(classDefine).toBeDefined();
    expect(classDefine!.kind).toBe("class");

    const methods = graph.defines.filter((d) => d.kind === "method");
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("handleRequest");
    expect(methodNames).toContain("validate");

    const containsPairs = graph.contains.map((c) => `${c.parent}->${c.child}`);
    expect(containsPairs).toContain("MyService->handleRequest");
    expect(containsPairs).toContain("MyService->validate");
  });

  it("extracts import statements", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `import { query, validate } from './db';`,
    }]);

    expect(graph.imports).toHaveLength(2);
    const names = graph.imports.map((i) => i.name);
    expect(names).toContain("query");
    expect(names).toContain("validate");
    expect(graph.imports.every((i) => i.source === "./db")).toBe(true);
  });

  it("extracts export statements", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `
        export function main() {}
        export { helper };
      `,
    }]);

    const exportNames = graph.exports.map((e) => e.name);
    expect(exportNames).toContain("main");
    expect(exportNames).toContain("helper");
  });

  it("combines facts across multiple files", () => {
    const graph = extractGraph([
      {
        path: "server.ts",
        content: `
          import { query } from './db';
          export function handleRequest() { query(); }
        `,
      },
      {
        path: "db.ts",
        content: `export function query() { connect(); }
                  function connect() {}`,
      },
    ]);

    // Cross-file: handleRequest calls query, query calls connect
    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("handleRequest->query");
    expect(callPairs).toContain("query->connect");

    // Imports
    expect(graph.imports.some((i) => i.name === "query" && i.source === "./db")).toBe(true);

    // Exports from both files
    const exportNames = graph.exports.map((e) => e.name);
    expect(exportNames).toContain("handleRequest");
    expect(exportNames).toContain("query");
  });

  it("deduplicates call edges", () => {
    const graph = extractGraph([{
      path: "test.ts",
      content: `function a() { b(); b(); b(); }
                function b() {}`,
    }]);

    const aToBCalls = graph.calls.filter((c) => c.caller === "a" && c.callee === "b");
    expect(aToBCalls).toHaveLength(1);
  });

  it("skips unsupported file extensions", () => {
    const graph = extractGraph([{
      path: "test.rb",
      content: `def hello; puts "hi"; end`,
    }]);

    expect(graph.defines).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
  });
});
