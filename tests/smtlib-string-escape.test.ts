import { describe, it, expect } from "vitest";
import { lintSpec } from "../src/formalize/validate.js";

describe("SMT-LIB string literal validation", () => {
  it("handles SMT-LIB doubled-quote escape within strings", () => {
    const spec = `(assert (= x "He said ""hello"""))`;
    const result = lintSpec(spec, "z3");
    expect(result.errors).not.toContain(
      expect.stringContaining("Unbalanced"),
    );
  });

  it("handles nested parens inside SMT-LIB strings with doubled quotes", () => {
    const spec = `(assert (= x "a(""b"))`;
    const result = lintSpec(spec, "z3");
    expect(result.errors).not.toContain(
      expect.stringContaining("Unbalanced"),
    );
  });

  it("reports unbalanced parens outside strings correctly", () => {
    const spec = `(assert (= x "hello")`;
    const result = lintSpec(spec, "z3");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unbalanced"),
      ]),
    );
  });

  it("does not misinterpret backslash before quote as escape", () => {
    const spec = `(assert (= msg "hello\\"extra"))`;
    const result = lintSpec(spec, "z3");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unbalanced"),
      ]),
    );
  });
});
