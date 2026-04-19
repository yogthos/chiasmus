import { describe, it, expect } from "vitest";
import { VectorStore } from "../../src/search/vector-store.js";

describe("VectorStore (R9)", () => {
  function unit(v: number[]): number[] {
    let sum = 0;
    for (const x of v) sum += x * x;
    const mag = Math.sqrt(sum) || 1;
    return v.map((x) => x / mag);
  }

  it("inserts vectors and finds nearest by cosine similarity", () => {
    const store = new VectorStore({ dimension: 3 });
    store.add({ id: "a", vector: unit([1, 0, 0]), metadata: { tag: "x-axis" } });
    store.add({ id: "b", vector: unit([0, 1, 0]), metadata: { tag: "y-axis" } });
    store.add({ id: "c", vector: unit([0, 0, 1]), metadata: { tag: "z-axis" } });

    const results = store.search(unit([0.9, 0.1, 0]), 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].metadata).toEqual({ tag: "x-axis" });
  });

  it("upsert replaces an existing id", () => {
    const store = new VectorStore({ dimension: 3 });
    store.add({ id: "a", vector: unit([1, 0, 0]) });
    store.add({ id: "a", vector: unit([0, 1, 0]) });
    expect(store.size()).toBe(1);
    const results = store.search(unit([0, 1, 0]), 1);
    expect(results[0].id).toBe("a");
    // Closest to [0,1,0] now
    expect(results[0].score).toBeCloseTo(1, 3);
  });

  it("remove deletes a vector by id", () => {
    const store = new VectorStore({ dimension: 2 });
    store.add({ id: "a", vector: unit([1, 0]) });
    store.add({ id: "b", vector: unit([0, 1]) });
    expect(store.remove("a")).toBe(true);
    expect(store.size()).toBe(1);
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("has() checks for id presence", () => {
    const store = new VectorStore({ dimension: 2 });
    store.add({ id: "a", vector: [1, 0] });
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
  });

  it("rejects vectors of wrong dimension", () => {
    const store = new VectorStore({ dimension: 3 });
    expect(() =>
      store.add({ id: "bad", vector: [1, 0] }),
    ).toThrow(/dimension/i);
  });

  it("returns empty array when store is empty", () => {
    const store = new VectorStore({ dimension: 3 });
    expect(store.search([1, 0, 0], 10)).toEqual([]);
  });

  it("topK > size returns all vectors", () => {
    const store = new VectorStore({ dimension: 2 });
    store.add({ id: "a", vector: unit([1, 0]) });
    store.add({ id: "b", vector: unit([0, 1]) });
    const results = store.search(unit([1, 1]), 10);
    expect(results).toHaveLength(2);
  });

  it("serialize → parse round-trips", () => {
    const store = new VectorStore({ dimension: 2 });
    store.add({ id: "a", vector: [1, 0], metadata: { foo: "bar" } });
    store.add({ id: "b", vector: [0, 1] });
    const serialized = store.serialize();
    const restored = VectorStore.parse(serialized);
    expect(restored.size()).toBe(2);
    expect(restored.has("a")).toBe(true);
    expect(restored.has("b")).toBe(true);
    const r = restored.search([1, 0], 1);
    expect(r[0].id).toBe("a");
    expect(r[0].metadata).toEqual({ foo: "bar" });
  });

  it("parse rejects an incompatible schema version", () => {
    const payload = JSON.stringify({ schemaVersion: "999", dimension: 2, vectors: [] });
    expect(() => VectorStore.parse(payload)).toThrow(/schema/i);
  });
});
