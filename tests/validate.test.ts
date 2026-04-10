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

    it("Prolog with doubled-quote escape in atom passes", () => {
      // 'it''s' is a valid ISO-Prolog atom meaning "it's". The lint must
      // not treat the inner '' as a terminator/opener and then see phantom
      // unbalanced parentheses in trailing content.
      const result = lintSpec(
        "says(user, 'it''s fine').",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
    });

    it("Prolog with backslash-quote escape in atom passes", () => {
      const result = lintSpec(
        "says(user, 'it\\'s fine').",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
    });

    it("Prolog with % inside an atom is not treated as a line comment", () => {
      // A % inside a quoted atom is just a char, not a comment.
      // The naive comment stripper would eat everything to EOL, leaving
      // an unterminated atom and unbalanced parens.
      const result = lintSpec(
        "p('50% done').",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
    });

    it("Prolog with a paren inside a quoted atom is not counted as structural", () => {
      // A `(` inside a quoted atom must not affect paren balance.
      const result = lintSpec(
        "p('opener: (').",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
    });

    it("Prolog with /* inside an atom is not treated as a block comment", () => {
      const result = lintSpec(
        "p('/* not a comment */').",
        "prolog"
      );
      expect(result.errors).toHaveLength(0);
    });
  });
});
