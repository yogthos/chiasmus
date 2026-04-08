import { describe, it, expect } from "vitest";
import { correctionLoop } from "../src/solvers/correction-loop.js";
import type { SpecFixer } from "../src/solvers/correction-loop.js";

describe("Correction Loop", () => {
  describe("Z3", () => {
    it("passes through a correct spec without correction", async () => {
      const fixer: SpecFixer = async () => {
        throw new Error("Fixer should not be called for correct input");
      };

      const result = await correctionLoop(
        {
          type: "z3",
          smtlib: `
            (declare-const x Int)
            (assert (= x 42))
          `,
        },
        fixer,
      );

      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(1);
      expect(result.result.status).toBe("sat");
      expect(result.history).toHaveLength(1);
    });

    it("fixes a minor syntax error within 2 rounds", async () => {
      // Spec has type mismatch: comparing Int > String
      const fixer: SpecFixer = async (attempt, error, round) => {
        if (round === 1 && attempt.type === "z3") {
          // Fix: replace the bad comparison with a valid one
          return {
            type: "z3",
            smtlib: `
              (declare-const x Int)
              (assert (> x 5))
            `,
          };
        }
        return null;
      };

      const result = await correctionLoop(
        {
          type: "z3",
          smtlib: `(declare-const x Int) (assert (> x "five"))`,
        },
        fixer,
      );

      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(2);
      expect(result.result.status).toBe("sat");
    });

    it("handles multi-round fixes for semantic errors", async () => {
      let fixAttempt = 0;
      const fixer: SpecFixer = async (attempt, error) => {
        fixAttempt++;
        if (fixAttempt === 1) {
          // First fix: still broken (wrong type)
          return {
            type: "z3",
            smtlib: `(declare-const x Int) (assert (> x "ten"))`,
          };
        }
        if (fixAttempt === 2) {
          // Second fix: correct
          return {
            type: "z3",
            smtlib: `(declare-const x Int) (assert (> x 10))`,
          };
        }
        return null;
      };

      const result = await correctionLoop(
        {
          type: "z3",
          smtlib: `(declare-const x Int) (assert (> x "bad"))`,
        },
        fixer,
      );

      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(3);
      expect(result.history).toHaveLength(3);
      // First two rounds should be errors
      expect(result.history[0].result.status).toBe("error");
      expect(result.history[1].result.status).toBe("error");
      // Third round succeeds
      expect(result.history[2].result.status).toBe("sat");
    });

    it("hits max rounds on unfixable spec and returns diagnostics", async () => {
      // Fixer always returns the same broken spec
      const fixer: SpecFixer = async () => ({
        type: "z3",
        smtlib: `(declare-const x Int) (assert (> x "always_broken"))`,
      });

      const result = await correctionLoop(
        {
          type: "z3",
          smtlib: `(declare-const x Int) (assert (> x "broken"))`,
        },
        fixer,
        { maxRounds: 3 },
      );

      expect(result.converged).toBe(false);
      expect(result.rounds).toBe(3);
      expect(result.result.status).toBe("error");
      expect(result.history).toHaveLength(3);
      // Every round should be an error
      for (const attempt of result.history) {
        expect(attempt.result.status).toBe("error");
      }
    });

    it("correctly distinguishes solver errors from valid UNSAT", async () => {
      const fixer: SpecFixer = async (attempt, error, round) => {
        // Fix the syntax error — the fixed version is unsatisfiable
        return {
          type: "z3",
          smtlib: `
            (declare-const x Int)
            (assert (> x 10))
            (assert (< x 5))
          `,
        };
      };

      const result = await correctionLoop(
        {
          type: "z3",
          smtlib: `(declare-const x Int) (assert (> x "bad"))`,
        },
        fixer,
      );

      // UNSAT is a valid result, not an error — loop should converge
      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(2);
      expect(result.result.status).toBe("unsat");
    });

    it("stops early when fixer gives up (returns null)", async () => {
      let fixerCalls = 0;
      const fixer: SpecFixer = async () => {
        fixerCalls++;
        return null; // give up immediately
      };

      const result = await correctionLoop(
        {
          type: "z3",
          smtlib: `(declare-const x Int) (assert (> x "bad"))`,
        },
        fixer,
        { maxRounds: 5 },
      );

      expect(result.converged).toBe(false);
      expect(fixerCalls).toBe(1);
      expect(result.rounds).toBe(1);
    });
  });

  describe("enhanced feedback", () => {
    it("passes full SolverResult to fixer via result parameter", async () => {
      let capturedResult: unknown = null;
      const fixer: SpecFixer = async (attempt, error, round, result) => {
        capturedResult = result;
        return null; // give up after capturing
      };

      await correctionLoop(
        {
          type: "z3",
          smtlib: `(declare-const x Int) (assert (> x "bad"))`,
        },
        fixer,
      );

      expect(capturedResult).toBeDefined();
      expect((capturedResult as any).status).toBe("error");
      expect((capturedResult as any).error).toBeTruthy();
    });
  });

  describe("Prolog", () => {
    it("passes through a correct Prolog program without correction", async () => {
      const fixer: SpecFixer = async () => {
        throw new Error("Should not be called");
      };

      const result = await correctionLoop(
        {
          type: "prolog",
          program: "parent(tom, bob).",
          query: "parent(tom, X).",
        },
        fixer,
      );

      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(1);
      expect(result.result.status).toBe("success");
    });

    it("fixes a malformed Prolog program", async () => {
      const fixer: SpecFixer = async (attempt, error, round) => {
        // Fix: add missing comma
        return {
          type: "prolog",
          program: "parent(tom, bob).",
          query: "parent(tom, X).",
        };
      };

      const result = await correctionLoop(
        {
          type: "prolog",
          program: "parent(tom bob).", // missing comma
          query: "parent(tom, X).",
        },
        fixer,
      );

      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(2);
      expect(result.result.status).toBe("success");
    });

    it("provides error history for debugging", async () => {
      let round = 0;
      const fixer: SpecFixer = async () => {
        round++;
        if (round < 3) {
          return {
            type: "prolog",
            program: `parent(tom bob).`, // still broken
            query: "parent(tom, X).",
          };
        }
        return {
          type: "prolog",
          program: `parent(tom, bob).`, // fixed
          query: "parent(tom, X).",
        };
      };

      const result = await correctionLoop(
        {
          type: "prolog",
          program: "parent(tom bob).",
          query: "parent(tom, X).",
        },
        fixer,
      );

      expect(result.converged).toBe(true);
      expect(result.rounds).toBe(4);
      // Verify error history is preserved
      expect(result.history[0].result.status).toBe("error");
      expect(result.history[1].result.status).toBe("error");
      expect(result.history[2].result.status).toBe("error");
      expect(result.history[3].result.status).toBe("success");
    });
  });
});
