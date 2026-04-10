import { describe, it, expect } from "vitest";
import { parseSource, parseSourceAsync } from "../../src/graph/parser.js";

describe("parser resource reuse", () => {
  it("reuses parser instance across multiple parseSource calls", () => {
    const results: any[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(parseSource(`function f${i}() {}`, "test.ts"));
    }
    for (const tree of results) {
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("program");
    }
  });

  it("handles parsing different languages sequentially", () => {
    const ts = parseSource("function ts_fn() {}", "test.ts");
    expect(ts).not.toBeNull();
    expect(ts.rootNode.type).toBe("program");

    const js = parseSource("function js_fn() {}", "test.js");
    expect(js).not.toBeNull();
    expect(js.rootNode.type).toBe("program");

    const py = parseSource("def py_fn(): pass", "test.py");
    expect(py).not.toBeNull();
    expect(py.rootNode.type).toBe("module");
  });

  it("reuses async parser across multiple parseSourceAsync calls", async () => {
    const results: any[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(await parseSourceAsync(`const x${i} = ${i};`, "test.ts"));
    }
    for (const tree of results) {
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("program");
    }
  });
});
