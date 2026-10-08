import { describe, it, expect, afterEach } from "vitest";
import { isFatalWasmError, wasmFailure } from "../../src/graph/parser.js";
import { registerAdapter, clearAdapters } from "../../src/graph/adapter-registry.js";
import { extractGraph } from "../../src/graph/extractor.js";
import type { LanguageAdapter } from "../../src/graph/types.js";

function throwingAdapter(error: unknown): LanguageAdapter {
  return {
    language: "boom-lang",
    extensions: [".boom"],
    grammar: { package: "tree-sitter-javascript" },
    extract() {
      throw error;
    },
  };
}

afterEach(() => {
  clearAdapters();
});

describe("isFatalWasmError", () => {
  it("flags WASM traps and Emscripten aborts", () => {
    expect(isFatalWasmError(new WebAssembly.RuntimeError("memory access out of bounds"))).toBe(true);
    expect(isFatalWasmError(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isFatalWasmError(new WebAssembly.RuntimeError("Aborted(Cannot enlarge memory arrays)"))).toBe(true);
    // Re-wrapped errors lose the RuntimeError class but keep the message.
    expect(isFatalWasmError(new Error("memory access out of bounds"))).toBe(true);
    expect(isFatalWasmError(new Error("Aborted(OOM)"))).toBe(true);
  });

  it("ignores ordinary errors", () => {
    expect(isFatalWasmError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isFatalWasmError(new TypeError("x is not a function"))).toBe(false);
    expect(isFatalWasmError("nope")).toBe(false);
  });
});

describe("extractGraph records a fatal WASM failure", () => {
  // Order matters: the failure flag is per process (module state) and never
  // resets — the process that recorded it must be discarded (the graph child is).
  it("does not record ordinary extraction errors", async () => {
    registerAdapter(throwingAdapter(new Error("adapter bug")));
    await expect(extractGraph([{ path: "/x/a.boom", content: "function a() {}" }])).rejects.toThrow("adapter bug");
    expect(wasmFailure()).toBeNull();
  });

  it("records a WASM trap raised while extracting a file and still rethrows it", async () => {
    registerAdapter(throwingAdapter(new WebAssembly.RuntimeError("memory access out of bounds")));
    await expect(extractGraph([{ path: "/x/a.boom", content: "function a() {}" }]))
      .rejects.toThrow("memory access out of bounds");
    expect(wasmFailure()).toBe("memory access out of bounds");
  });
});
