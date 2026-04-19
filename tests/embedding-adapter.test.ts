import { describe, it, expect } from "vitest";
import { MockEmbeddingAdapter } from "../src/llm/mock.js";

describe("EmbeddingAdapter interface (R10)", () => {
  it("mock returns deterministic vectors of the configured dimension", async () => {
    const adapter = new MockEmbeddingAdapter({ dimension: 4 });
    const vecs = await adapter.embed(["hello", "world"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(4);
    expect(vecs[1]).toHaveLength(4);
    // Deterministic: same input → same vector
    const again = await adapter.embed(["hello"]);
    expect(again[0]).toEqual(vecs[0]);
  });

  it("mock produces distinct vectors for distinct inputs", async () => {
    const adapter = new MockEmbeddingAdapter({ dimension: 8 });
    const [a, b] = await adapter.embed(["alpha", "beta"]);
    expect(a).not.toEqual(b);
  });

  it("mock exposes dimension() matching configured size", () => {
    const adapter = new MockEmbeddingAdapter({ dimension: 16 });
    expect(adapter.dimension()).toBe(16);
  });

  it("mock batch returns in the same order as inputs", async () => {
    const adapter = new MockEmbeddingAdapter({ dimension: 3 });
    const inputs = ["one", "two", "three", "four"];
    const vecs = await adapter.embed(inputs);
    expect(vecs).toHaveLength(4);
    // Each vec should match what a single-element call yields.
    for (let i = 0; i < inputs.length; i++) {
      const single = await adapter.embed([inputs[i]]);
      expect(vecs[i]).toEqual(single[0]);
    }
  });
});
