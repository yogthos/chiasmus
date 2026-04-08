import { describe, it, expect, afterEach } from "vitest";
import { createPrologSolver } from "../src/solvers/prolog-solver.js";
import type { Solver } from "../src/solvers/types.js";

describe("PrologSolver", () => {
  let solver: Solver;

  afterEach(() => {
    solver?.dispose();
  });

  it("resolves simple fact queries", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
        parent(tom, bob).
        parent(bob, ann).
        parent(bob, pat).
      `,
      query: "parent(tom, X).",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0].bindings.X).toBe("bob");
    }
  });

  it("resolves recursive rules", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
        parent(tom, bob).
        parent(bob, ann).
        ancestor(X, Y) :- parent(X, Y).
        ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
      `,
      query: "ancestor(tom, Who).",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const names = result.answers.map((a) => a.bindings.Who);
      expect(names).toContain("bob");
      expect(names).toContain("ann");
    }
  });

  it("returns empty answers for unsatisfiable queries", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `parent(tom, bob).`,
      query: "parent(bob, tom).",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers).toHaveLength(0);
    }
  });

  it("returns a structured error for malformed programs", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `parent(tom bob.`,
      query: "parent(tom, X).",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeTruthy();
      expect(typeof result.error).toBe("string");
    }
  });

  it("returns a structured error for malformed queries", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `parent(tom, bob).`,
      query: "parent(tom X.",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeTruthy();
    }
  });

  it("handles ground queries (no variables)", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `parent(tom, bob).`,
      query: "parent(tom, bob).",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("handles arithmetic", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
        factorial(0, 1).
        factorial(N, F) :- N > 0, N1 is N - 1, factorial(N1, F1), F is N * F1.
      `,
      query: "factorial(5, F).",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0].bindings.F).toBe("120");
    }
  });

  describe("derivation traces", () => {
    it("returns trace for rule chain when explain=true", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `
          parent(tom, bob).
          parent(bob, ann).
          ancestor(X, Y) :- parent(X, Y).
          ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
        `,
        query: "ancestor(tom, Who).",
        explain: true,
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.length).toBeGreaterThan(0);
        // Trace should be present and show fired rules
        expect(result.trace).toBeDefined();
        expect(Array.isArray(result.trace)).toBe(true);
        expect(result.trace!.length).toBeGreaterThan(0);
        // Should contain ancestor rule applications
        const traceStr = result.trace!.join(" ");
        expect(traceStr).toMatch(/ancestor/);
      }
    });

    it("returns no trace when explain is false (default)", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `
          parent(tom, bob).
          ancestor(X, Y) :- parent(X, Y).
        `,
        query: "ancestor(tom, X).",
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.trace).toBeUndefined();
      }
    });

    it("returns trace for ground query with explain=true", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `
          parent(tom, bob).
          ancestor(X, Y) :- parent(X, Y).
        `,
        query: "ancestor(tom, bob).",
        explain: true,
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.trace).toBeDefined();
        expect(result.trace!.length).toBeGreaterThan(0);
      }
    });

    it("returns trace with multiple rule applications", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `
          edge(a, b).
          edge(b, c).
          path(X, Y) :- edge(X, Y).
          path(X, Y) :- edge(X, Z), path(Z, Y).
        `,
        query: "path(a, c).",
        explain: true,
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.trace).toBeDefined();
        const traceStr = result.trace!.join(" ");
        // Should show path rule applications
        expect(traceStr).toMatch(/path/);
      }
    });
  });

  it("handles list operations", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
        member(X, [X|_]).
        member(X, [_|T]) :- member(X, T).
      `,
      query: "member(X, [a, b, c]).",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const values = result.answers.map((a) => a.bindings.X);
      expect(values).toContain("a");
      expect(values).toContain("b");
      expect(values).toContain("c");
    }
  });
});
