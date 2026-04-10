import { describe, it, expect, afterEach } from "vitest";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import type { Solver } from "../src/solvers/types.js";

describe("Z3Solver resource management", () => {
  let solver: Solver;

  afterEach(() => {
    solver?.dispose();
  });

  it("returns error when used after disposal", async () => {
    solver = await createZ3Solver();
    solver.dispose();

    const result = await solver.solve({
      type: "z3",
      smtlib: `(declare-const x Int) (assert (= x 1))`,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(/disposed/i);
    }
  });

  it("dispose is idempotent — calling twice does not throw", async () => {
    solver = await createZ3Solver();
    solver.dispose();
    expect(() => solver.dispose()).not.toThrow();
  });

  it("solver works correctly then can be disposed and recreated", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `(declare-const x Int) (assert (= x 42))`,
    });
    expect(result.status).toBe("sat");
    solver.dispose();

    const solver2 = await createZ3Solver();
    try {
      const result2 = await solver2.solve({
        type: "z3",
        smtlib: `(declare-const y Int) (assert (= y 99))`,
      });
      expect(result2.status).toBe("sat");
      if (result2.status === "sat") {
        expect(result2.model.y).toBe("99");
      }
    } finally {
      solver2.dispose();
    }
  });

  it("handles multiple solve calls on the same solver instance", async () => {
    solver = await createZ3Solver();

    for (let i = 0; i < 5; i++) {
      const result = await solver.solve({
        type: "z3",
        smtlib: `(declare-const x Int) (assert (= x ${i}))`,
      });
      expect(result.status).toBe("sat");
      if (result.status === "sat") {
        expect(result.model.x).toBe(String(i));
      }
    }
  });
});
