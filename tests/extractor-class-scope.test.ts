import { describe, it, expect } from "vitest";
import { extractGraph } from "../src/graph/extractor.js";

describe("extractor: class scope stack", () => {
  it("attributes calls in class body static fields to the class", async () => {
    const code = `class MyClass {
  static x = foo();
}`;
    const graph = await extractGraph([
      { path: "test.js", content: code },
    ]);
    const callsInClass = graph.calls.filter((c) => c.caller === "MyClass");
    expect(callsInClass.length).toBeGreaterThanOrEqual(1);
    expect(callsInClass.some((c) => c.callee === "foo")).toBe(true);
  });
});
