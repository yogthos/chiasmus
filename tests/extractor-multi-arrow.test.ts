import { describe, it, expect } from "vitest";
import { extractGraph } from "../src/graph/extractor.js";

describe("extractor: multiple arrow functions in one declaration", () => {
  it("registers all arrow functions from const a = () => {}, b = () => {}", async () => {
    const code = `const a = () => { foo(); }, b = () => { bar(); };`;
    const graph = await extractGraph([
      { path: "test.js", content: code },
    ]);
    const fnNames = graph.defines.map((d) => d.name);
    expect(fnNames).toContain("a");
    expect(fnNames).toContain("b");
  });

  it("registers calls from all arrow functions", async () => {
    const code = `const a = () => { foo(); }, b = () => { bar(); };`;
    const graph = await extractGraph([
      { path: "test.js", content: code },
    ]);
    const callees = graph.calls.map((c) => c.callee);
    expect(callees).toContain("foo");
    expect(callees).toContain("bar");
  });

  it("handles mix of arrow and non-arrow in same declaration", async () => {
    const code = `const fn = () => { baz(); }, x = 42;`;
    const graph = await extractGraph([
      { path: "test.js", content: code },
    ]);
    const fnNames = graph.defines.map((d) => d.name);
    expect(fnNames).toContain("fn");
    const callees = graph.calls.map((c) => c.callee);
    expect(callees).toContain("baz");
  });

  it("walks non-arrow initializer alongside arrow functions", async () => {
    const code = `const fn = () => { foo(); }, x = bar();`;
    const graph = await extractGraph([
      { path: "test.js", content: code },
    ]);
    const fnNames = graph.defines.map((d) => d.name);
    expect(fnNames).toContain("fn");
    expect(fnNames).not.toContain("x");
    const callees = graph.calls.map((c) => c.callee);
    expect(callees).toContain("foo");
  });
});
