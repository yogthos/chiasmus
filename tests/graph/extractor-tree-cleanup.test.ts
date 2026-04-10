import { describe, it, expect, vi } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import * as parser from "../../src/graph/parser.js";

describe("extractGraph tree cleanup", () => {
  it("calls tree.delete() on the returned tree to free WASM/native memory", async () => {
    // Intercept parseSource: wrap the real tree so we can observe delete().
    const realParseSource = parser.parseSource;
    const deleteSpies: Array<ReturnType<typeof vi.fn>> = [];

    const spy = vi
      .spyOn(parser, "parseSource")
      .mockImplementation((content: string, filePath: string) => {
        const tree = realParseSource(content, filePath);
        if (!tree) return tree;
        // Trees returned by native tree-sitter don't have `delete` — add a spy.
        const deleteFn = vi.fn();
        deleteSpies.push(deleteFn);
        (tree as any).delete = deleteFn;
        return tree;
      });

    try {
      await extractGraph([
        { path: "a.ts", content: "function a() { b(); }" },
        { path: "b.ts", content: "function b() {}" },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(deleteSpies.length).toBe(2);
    for (const d of deleteSpies) {
      expect(d).toHaveBeenCalledTimes(1);
    }
  });

  it("does not crash when tree lacks a delete method (native trees)", async () => {
    // Native tree-sitter trees have no delete() — extractGraph must still succeed.
    await expect(
      extractGraph([{ path: "x.ts", content: "function x() {}" }]),
    ).resolves.toBeDefined();
  });
});
