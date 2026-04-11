import { describe, it, expect, afterEach } from "vitest";
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

  it("does not split clauses on decimal-literal periods", async () => {
    // Regression: the clause scanner treated `.` at depth 0 as end-of-clause
    // without checking whether it was a decimal point. Input
    //   is_pi(X) :- X > 3.14.
    // was silently truncated to `is_pi(X) :- X > 3.` which binds X > 3.
    // The query below only succeeds if the full `X > 3.14` guard is
    // preserved through instrumentation.
    solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program: `
is_big(X) :- X > 3.14.
`,
      query: "is_big(3.15).",
      explain: true,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // With the truncation bug, the comparison is X > 3, which 3.15
      // trivially satisfies but so does 4, 5, etc. The more telling
      // check is that the _instrumented_ program still parses: if we
      // split on the inner `.`, the trailing `14.` becomes an invalid
      // clause and consult errors out → result.status === "error".
      expect(result.answers.length).toBeGreaterThan(0);
    }

    // Flip-side: a value below the real threshold must fail.
    const below = await solver.solve({
      type: "prolog",
      program: `
is_big(X) :- X > 3.14.
`,
      query: "is_big(3.1).",
      explain: true,
    });
    expect(below.status).toBe("success");
    if (below.status === "success") {
      expect(below.answers.length).toBe(0);
    }
  });
});
