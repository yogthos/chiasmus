import { describe, it, expect } from "vitest";
import { parseSource, getLanguageForFile, getSupportedExtensions } from "../../src/graph/parser.js";

describe("parser", () => {
  it("parses TypeScript source and returns tree with rootNode", () => {
    const tree = parseSource("function hello() {}", "test.ts");
    expect(tree).not.toBeNull();
    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.childCount).toBeGreaterThan(0);
  });

  it("parses JavaScript source", () => {
    const tree = parseSource("function foo() { bar(); }", "test.js");
    expect(tree).not.toBeNull();
    expect(tree.rootNode.type).toBe("program");
  });

  it("returns null for unsupported extension", () => {
    const tree = parseSource("some content", "test.unknown");
    expect(tree).toBeNull();
  });

  it("maps extensions to languages correctly", () => {
    expect(getLanguageForFile("foo.ts")).toBe("typescript");
    expect(getLanguageForFile("foo.tsx")).toBe("tsx");
    expect(getLanguageForFile("foo.js")).toBe("javascript");
    expect(getLanguageForFile("foo.mjs")).toBe("javascript");
    expect(getLanguageForFile("foo.unknown")).toBeNull();
  });

  it("lists supported extensions", () => {
    const exts = getSupportedExtensions();
    expect(exts).toContain(".ts");
    expect(exts).toContain(".js");
    expect(exts).toContain(".tsx");
  });
});
