import { describe, it, expect } from "vitest";
import { extractGraph } from "../src/graph/extractor.js";

describe("extractor: cross-file call dedup", () => {
  it("preserves same caller->callee edge across two files", async () => {
    const codeA = `function foo() { bar(); }`;
    const codeB = `function foo() { bar(); }`;
    const graph = await extractGraph([
      { path: "a.js", content: codeA },
      { path: "b.js", content: codeB },
    ]);
    const fooToBar = graph.calls.filter(
      (c) => c.caller === "foo" && c.callee === "bar",
    );
    expect(fooToBar.length).toBe(2);
  });
});
