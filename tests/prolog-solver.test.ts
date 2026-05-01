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

  describe("disposal", () => {
    it("returns an error when solve is called after dispose", async () => {
      const s = createPrologSolver();
      s.dispose();
      const result = await s.solve({
        type: "prolog",
        program: "f(1).",
        query: "f(X).",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toMatch(/dispos/i);
      }
    });
  });

  describe("inference budget", () => {
    it("honors a custom maxInferences on the solver input", async () => {
      // A very low budget must cause a limit-exceeded error on a program
      // that would normally succeed, proving the knob is wired through.
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `
          f(0).
          f(N) :- N > 0, N1 is N - 1, f(N1).
        `,
        query: "f(50).",
        maxInferences: 10,
      });
      expect(result.status).toBe("error");
    });

    it("allows raising the budget for analyses that need more headroom", async () => {
      // Default budget (100_000) is plenty for this query, but we also want
      // to prove that a raised budget still works — the raise path exists.
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `
          f(0).
          f(N) :- N > 0, N1 is N - 1, f(N1).
        `,
        query: "f(50).",
        maxInferences: 5_000_000,
      });
      expect(result.status).toBe("success");
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

  describe("module isolation", () => {
    it("isolates predicates across sequential solves", async () => {
      // First solve defines color/1; second solve must not see it.
      const s1 = createPrologSolver();
      const r1 = await s1.solve({
        type: "prolog",
        program: "color(red). color(blue).",
        query: "color(X).",
      });
      expect(r1.status).toBe("success");
      s1.dispose();

      const s2 = createPrologSolver();
      const r2 = await s2.solve({
        type: "prolog",
        program: "",
        query: "color(X).",
      });
      // Each solve runs in its own module, so color/1 from the previous
      // solve is unreachable. The catch wrap converts existence_error
      // into a structured error.
      expect(r2.status).toBe("error");
      if (r2.status === "error") {
        expect(r2.error).toMatch(/existence_error|color/);
      }
      s2.dispose();
    });

    it("isolates concurrent solves with overlapping predicate names", async () => {
      const a = createPrologSolver();
      const b = createPrologSolver();
      const [ra, rb] = await Promise.all([
        a.solve({
          type: "prolog",
          program: "color(red). color(blue).",
          query: "color(X).",
        }),
        b.solve({
          type: "prolog",
          program: "color(green). color(yellow).",
          query: "color(X).",
        }),
      ]);
      expect(ra.status).toBe("success");
      expect(rb.status).toBe("success");
      if (ra.status === "success" && rb.status === "success") {
        const aXs = ra.answers.map((x) => x.bindings.X).sort();
        const bXs = rb.answers.map((x) => x.bindings.X).sort();
        expect(aXs).toEqual(["blue", "red"]);
        expect(bXs).toEqual(["green", "yellow"]);
      }
      a.dispose();
      b.dispose();
    });

    it("imports library(lists) into the session module", async () => {
      // member/2 lives in library(lists); the session module imports it.
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: "colors([red, green, blue]).",
        query: "colors(L), member(X, L).",
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const xs = result.answers.map((a) => a.bindings.X);
        expect(xs).toEqual(["red", "green", "blue"]);
      }
    });

    it("imports library(clpfd) into the session module", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program:
          "schedule(X, Y) :- [X, Y] ins 1..5, X + Y #= 7, X #< Y, label([X, Y]).",
        query: "schedule(X, Y).",
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.length).toBeGreaterThan(0);
      }
    });
  });

  describe("undefined predicate in query", () => {
    it("surfaces an existence_error rather than silently returning empty", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: "",
        query: "totally_undefined(X).",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toMatch(/existence_error|totally_undefined/);
      }
    });

    it("surfaces existence_error from a defined goal that calls an undefined helper", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: "outer(X) :- inner(X).",
        query: "outer(X).",
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toMatch(/existence_error|inner/);
      }
    });
  });

  describe("instrumentation", () => {
    it("does not duplicate the final clause when input has no trailing whitespace", async () => {
      // Regression: the trailing-fragment branch fired even when the inner
      // loop had already emitted a rewritten clause flush against EOF,
      // resulting in `q/1` having two clauses (instrumented + raw) and
      // doubling the answer count.
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: "p(a). p(b). q(X) :- p(X).",
        query: "q(X).",
        explain: true,
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.map((a) => a.bindings.X)).toEqual(["a", "b"]);
      }
    });
  });
});
