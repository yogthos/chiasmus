import { describe, it, expect } from "vitest";
import { lintSpec } from "../src/formalize/validate.js";

describe("Spec Linting", () => {
  describe("auto-fixes", () => {
    it("strips markdown fences", () => {
      const result = lintSpec(
        "```smt\n(declare-const x Int)\n(assert (> x 5))\n```",
        "z3"
      );
      expect(result.errors).toHaveLength(0);
      expect(result.fixes.length).toBeGreaterThan(0);
      expect(result.spec).not.toContain("```");
      expect(result.spec).toContain("(declare-const x Int)");
    });

    it("removes check-sat from Z3 specs", () => {
      const result = lintSpec(
        "(declare-const x Int)\n(assert (> x 5))\n(check-sat)",
        "z3"
      );
      expect(result.errors).toHaveLength(0);
      expect(result.fixes.some((f) => f.match(/check-sat/i))).toBe(true);
      expect(result.spec).not.toContain("check-sat");
    });

    it("removes get-model from Z3 specs", () => {
      const result = lintSpec(
        "(declare-const x Int)\n(assert (> x 5))\n(get-model)",
        "z3"
      );
      expect(result.errors).toHaveLength(0);
      expect(result.spec).not.toContain("get-model");
    });

    it("removes set-logic from Z3 specs", () => {
      const result = lintSpec(
        "(set-logic QF_LIA)\n(declare-const x Int)\n(assert (> x 5))",
        "z3"
      );
      expect(result.errors).toHaveLength(0);
      expect(result.spec).not.toContain("set-logic");
    });
  });

  describe("error detection", () => {
    it("catches empty spec", () => {
      const result = lintSpec("", "z3");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/empty/i);
    });

    it("catches unfilled template slots", () => {
      const result = lintSpec(
        "(declare-const x Int)\n(assert (> x {{SLOT:threshold}}))",
        "z3"
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/SLOT:threshold/);
    });

    it("catches unbalanced Z3 parentheses (unclosed)", () => {
      const result = lintSpec(
        "(declare-const x Int)\n(assert (> x 5)",
        "z3"
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/unbalanced/i);
    });

    it("catches unbalanced Z3 parentheses (extra close)", () => {
      const result = lintSpec(
        "(declare-const x Int))\n(assert (> x 5))",
        "z3"
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/unmatched.*closing/i);
    });

    it("catches missing periods in Prolog", () => {
      const result = lintSpec(
        "parent(tom, bob)\nparent(bob, ann)",
        "prolog"
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/period/i);
    });

    it("catches unbalanced Prolog parentheses", () => {
      const result = lintSpec(
        "parent(tom, bob.\nparent(bob, ann).",
        "prolog"
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.match(/parenthes/i))).toBe(true);
    });
  });

  describe("valid specs pass clean", () => {
    it("valid Z3 passes with no errors or fixes", () => {
      const result = lintSpec(
        "(declare-const x Int)\n(assert (> x 5))",
        "z3"
      );
      expect(result.errors).toHaveLength(0);
      expect(result.fixes).toHaveLength(0);
    });

    it("valid Prolog passes with no errors or fixes", () => {
      const result = lintSpec(
        "parent(tom, bob).\nparent(bob, ann).",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
      expect(result.fixes).toHaveLength(0);
    });

    it("Z3 with comments passes", () => {
      const result = lintSpec(
        '; comment with (\n(declare-const x Int)\n(assert (= x 5))',
        "z3"
      );
      expect(result.errors).toHaveLength(0);
    });

    it("Prolog with comments passes", () => {
      const result = lintSpec(
        "% comment\nparent(tom, bob).",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
    });
  });
});
