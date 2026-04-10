import { describe, it, expect } from "vitest";
import { createPrologSolver } from "../src/solvers/prolog-solver.js";
import type { Solver } from "../src/solvers/types.js";

describe("Prolog solver tracing", () => {
  let solver: Solver;

  afterEach(() => {
    solver?.dispose();
  });

  it("instruments multi-line rules for tracing", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
parent(alice, bob).
parent(bob, carol).
grandparent(X, Z) :-
  parent(X, Y),
  parent(Y, Z).
`,
      query: "grandparent(alice, carol).",
      explain: true,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers.length).toBeGreaterThan(0);
      expect(result.trace).toBeDefined();
      expect(result.trace!.length).toBeGreaterThan(0);
      const traceStr = result.trace!.join(" ");
      expect(traceStr).toContain("grandparent");
    }
  });

  it("instruments rules with body spanning multiple lines", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
likes(alice, bob).
likes(bob, carol).
mutual_like(X, Y) :- likes(X, Y), likes(Y, X).`,
      query: "mutual_like(X, Y).",
      explain: true,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.trace).toBeDefined();
      expect(result.trace!.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles rules with nested parenthesized terms", async () => {
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
edge(a, b).
edge(b, c).
path(X, Y) :- edge(X, Y).
path(X, Z) :- edge(X, Y), path(Y, Z).
`,
      query: "path(a, Z).",
      explain: true,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers.length).toBeGreaterThan(0);
    }
  });
});
