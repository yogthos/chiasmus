import { describe, it, expect } from "vitest";
import { extractPrologQuery } from "../src/formalize/prolog-input.js";

describe("extractPrologQuery", () => {
  it("extracts ?- query from last line", () => {
    const input = "parent(alice, bob).\n?- parent(X, bob).";
    const result = extractPrologQuery(input);
    expect(result.program).toBe("parent(alice, bob).");
    expect(result.query).toBe("parent(X, bob).");
  });

  it("returns full text as program with 'true.' query when no ?- found", () => {
    const input = "parent(alice, bob).\nparent(bob, carol).";
    const result = extractPrologQuery(input);
    expect(result.program).toBe(input);
    expect(result.query).toBe("true.");
  });

  it("extracts ?- query from middle of text (uses last ?- line)", () => {
    const input = "parent(alice, bob).\n?- parent(X, bob).\n% comment";
    const result = extractPrologQuery(input);
    expect(result.program).toBe("parent(alice, bob).");
    expect(result.query).toBe("parent(X, bob).");
  });

  it("handles ?- with extra whitespace after dash", () => {
    const input = "parent(alice, bob).\n?-\tparent(X, bob).";
    const result = extractPrologQuery(input);
    expect(result.query).toBe("parent(X, bob).");
  });

  it("trims trailing whitespace from program", () => {
    const input = "parent(alice, bob).\n\n\n?- parent(X, bob).";
    const result = extractPrologQuery(input);
    expect(result.program).toBe("parent(alice, bob).");
  });
});
