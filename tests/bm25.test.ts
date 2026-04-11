import { describe, it, expect } from "vitest";
import { buildIndex, addToIndex, search } from "../src/skills/bm25.js";

describe("BM25 index", () => {
  describe("incremental add keeps IDF consistent", () => {
    // The regression: addToIndex used to only recompute IDF for terms in the
    // new document. Terms that existed only in older docs kept their stale
    // IDF based on the old N, so search scores drifted after every add.
    it("matches full rebuild for a term not in the added doc", () => {
      const initialTexts = [
        "alpha beta gamma",
        "alpha delta",
      ];

      // Build via incremental add: start from the first doc, then add the second
      const incremental = buildIndex([initialTexts[0]]);
      addToIndex(incremental, initialTexts[1]);

      // Build via full rebuild for comparison
      const full = buildIndex(initialTexts);

      // Both indices should have identical IDF for every term after both paths
      expect([...incremental.idf.keys()].sort()).toEqual([...full.idf.keys()].sort());
      for (const term of full.idf.keys()) {
        expect(
          incremental.idf.get(term),
          `IDF for "${term}" drifted after incremental add`,
        ).toBeCloseTo(full.idf.get(term)!, 10);
      }
    });

    it("matches full rebuild across many adds", () => {
      const texts = [
        "apple banana cherry",
        "apple pie",
        "banana bread",
        "cherry jam",
        "elderberry wine",
      ];

      const incremental = buildIndex([texts[0]]);
      for (let i = 1; i < texts.length; i++) {
        addToIndex(incremental, texts[i]);
      }

      const full = buildIndex(texts);

      for (const term of full.idf.keys()) {
        expect(
          incremental.idf.get(term),
          `IDF for "${term}" drifted`,
        ).toBeCloseTo(full.idf.get(term)!, 10);
      }
      expect(incremental.docs.length).toBe(full.docs.length);
      expect(incremental.avgLength).toBeCloseTo(full.avgLength, 10);
    });

    it("search scores after incremental add match full rebuild", () => {
      const texts = [
        "policy contradiction access control rules",
        "graph reachability data flow",
        "taint propagation source sink",
      ];

      const incremental = buildIndex([texts[0]]);
      for (let i = 1; i < texts.length; i++) {
        addToIndex(incremental, texts[i]);
      }
      const full = buildIndex(texts);

      const query = "data flow taint";
      const incResults = search(incremental, query, 10);
      const fullResults = search(full, query, 10);

      expect(incResults.length).toBe(fullResults.length);
      for (let i = 0; i < incResults.length; i++) {
        expect(incResults[i].docIndex).toBe(fullResults[i].docIndex);
        expect(incResults[i].score).toBeCloseTo(fullResults[i].score, 10);
      }
    });
  });
});
