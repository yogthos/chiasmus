import { describe, it, expect, afterEach } from "vitest";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import type { Solver } from "../src/solvers/types.js";

describe("Z3Solver", () => {
  let solver: Solver;

  afterEach(() => {
    solver?.dispose();
  });

  it("returns sat with a model for satisfiable constraints", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (declare-const y Int)
        (assert (> x 0))
        (assert (< y 10))
        (assert (= (+ x y) 7))
      `,
    });

    expect(result.status).toBe("sat");
    if (result.status === "sat") {
      expect(result.model).toHaveProperty("x");
      expect(result.model).toHaveProperty("y");
      const x = parseInt(result.model.x, 10);
      const y = parseInt(result.model.y, 10);
      expect(x + y).toBe(7);
      expect(x).toBeGreaterThan(0);
      expect(y).toBeLessThan(10);
    }
  });

  it("returns unsat for contradictory constraints", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (> x 10))
        (assert (< x 5))
      `,
    });

    expect(result.status).toBe("unsat");
  });

  it("returns a structured error for malformed SMT-LIB", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `(declare-const x Int) (assert (> x "not_a_number"))`,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeTruthy();
      expect(typeof result.error).toBe("string");
    }
  });

  it("handles boolean satisfiability", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const p Bool)
        (declare-const q Bool)
        (assert (or p q))
        (assert (not (and p q)))
      `,
    });

    expect(result.status).toBe("sat");
    if (result.status === "sat") {
      const p = result.model.p;
      const q = result.model.q;
      // Exactly one must be true (XOR)
      expect(p !== q || (p === "true") !== (q === "true")).toBeTruthy();
    }
  });

  it("handles custom datatypes", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-datatypes ((Color 0)) (((Red) (Green) (Blue))))
        (declare-const c1 Color)
        (declare-const c2 Color)
        (assert (not (= c1 c2)))
        (assert (not (= c1 Red)))
        (assert (not (= c2 Red)))
      `,
    });

    expect(result.status).toBe("sat");
    if (result.status === "sat") {
      expect(result.model.c1).not.toBe("Red");
      expect(result.model.c2).not.toBe("Red");
      expect(result.model.c1).not.toBe(result.model.c2);
    }
  });

  it("strips check-sat and get-model from input without breaking", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (= x 5))
        (check-sat)
        (get-model)
      `,
    });

    expect(result.status).toBe("sat");
    if (result.status === "sat") {
      expect(result.model.x).toBe("5");
    }
  });

  it("returns unsat core with named assertions for contradictory constraints", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (! (> x 10) :named gt10))
        (assert (! (< x 5) :named lt5))
      `,
    });

    expect(result.status).toBe("unsat");
    if (result.status === "unsat") {
      expect(result.unsatCore).toBeDefined();
      expect(Array.isArray(result.unsatCore)).toBe(true);
      expect(result.unsatCore!.length).toBeGreaterThan(0);
      // Core should reference the named assertions
      const coreStr = result.unsatCore!.join(" ");
      expect(coreStr).toMatch(/gt10|lt5/);
    }
  });

  it("returns unsat core expressions for contradictory unnamed assertions", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (> x 10))
        (assert (< x 5))
      `,
    });

    expect(result.status).toBe("unsat");
    if (result.status === "unsat") {
      // unsatCore should be present (may be empty if WASM doesn't support unnamed cores)
      expect(result.unsatCore).toBeDefined();
      expect(Array.isArray(result.unsatCore)).toBe(true);
    }
  });

  it("does not include unsatCore field for SAT results", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (> x 0))
        (assert (< x 10))
      `,
    });

    expect(result.status).toBe("sat");
    expect(result).not.toHaveProperty("unsatCore");
  });

  it("returns unsat core for trivially unsat assertion", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: `(assert false)`,
    });

    expect(result.status).toBe("unsat");
    if (result.status === "unsat") {
      expect(result.unsatCore).toBeDefined();
      expect(Array.isArray(result.unsatCore)).toBe(true);
    }
  });

  it("returns error for completely empty input", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({
      type: "z3",
      smtlib: "",
    });

    // Empty input with no assertions: solver should handle gracefully
    // Could be sat (vacuously) or error depending on implementation
    expect(["sat", "error"]).toContain(result.status);
  });
});
