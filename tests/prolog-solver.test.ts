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

    it("autoloads list predicates without a blanket weak import", async () => {
      // member/2 remains available through SWI's autoloader. Avoiding a
      // blanket use_module(library(lists)) lets user programs safely provide
      // their own member/2 without corrupting teardown state.
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

    it("parses CLP(FD) operators used directly in a query", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: "",
        query: "X in 1..3, label([X]).",
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.map((answer) => answer.bindings.X)).toEqual(["1", "2", "3"]);
      }
    });

    it("does not corrupt the runtime when a program defines a lists predicate", async () => {
      // SWI treats an explicit library(lists) import as weak: a local
      // member/2 definition overrides it. Repeatedly unloading that collision
      // used to trap in WASM and poison the process-wide Prolog singleton.
      solver = createPrologSolver();
      const edges = [
        ["refuse", "attach_refusal"],
        ["re_refuse", "attach_refusal"],
        ["re_refuse_holder_moved", "re_refuse"],
        ["attachable_holder", "refuse"],
        ["attach_workspace_to_holder", "attach_write_boundary"],
        ["attach_workspace_to_holder", "attachable_holder"],
        ["attach_workspace_to_holder", "re_refuse"],
        ["attach_workspace_to_holder", "re_refuse_holder_moved"],
        ["attach_workspace_to_holder", "attached"],
        ["attach_workspace_to_holder", "validate_bang"],
        ["attach_workspace_to_holder", "reread_workspace_after_race"],
        ["resolve_workspace", "attach_budget"],
        ["resolve_workspace", "attachable_holder"],
        ["resolve_workspace", "bootstrap_workspace_organization"],
        ["resolve_workspace", "attach_workspace_to_holder"],
        ["resolve_workspace", "validate_bang"],
        ["resolve_workspace_for_login", "resolve_workspace"],
        ["resolve_workspace_for_login", "lock_wait_exhausted"],
        ["resolve_workspace_for_login", "transient_attach_failure_message"],
        ["transient_attach_failure_message", "trc"],
        ["lock_wait_exhausted", "pg_error_fields"],
        ["process_access_token", "resolve_workspace_for_login"],
        ["process_access_token", "handle_workspace_login_with_retry"],
        ["process_access_token", "handle_basic_google_login"],
        ["process_access_token", "notify_new_workspace"],
        ["attach_write_boundary", "in_transaction_on"],
        ["attach_write_boundary", "execute_one_on"],
        ["attach_write_boundary", "execute_on"],
      ].map(([from, to]) => `calls(${from}, ${to}).`).join("\n");
      const program = `
        ${edges}
        member(X, [X|_]).
        member(X, [_|T]) :- member(X, T).
        reaches(A, B) :- reaches(A, B, [A]).
        reaches(A, B, _) :- calls(A, B).
        reaches(A, B, Visited) :- calls(A, Mid), \\+ member(Mid, Visited), reaches(Mid, B, [Mid|Visited]).
      `;

      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await solver.solve({
          type: "prolog",
          program,
          query: "reaches(process_access_token, attach_write_boundary).",
        });
        expect(result, `attempt ${attempt + 1}`).toMatchObject({ status: "success" });
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

  describe("wrapper-variable hygiene", () => {
    // Regression: the catch/inference-limit wrapper around every user goal
    // introduces helper variables. prolog-wasm-full surfaces them unbound on
    // the success path (tau-prolog did not), polluting answers with
    // `{"$t":"v","v":N}` noise. They must be stripped from every binding set.
    it("does not leak internal wrapper variables into bindings", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `color(red). color(green). sound :- color(red).`,
        query: "color(X).",
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        for (const answer of result.answers) {
          expect(Object.keys(answer.bindings)).toEqual(["X"]);
          expect(answer.formatted).not.toMatch(/Err|EStr|Chiasmus|\$t/);
        }
      }
    });

    it("renders a ground goal as clean `true` with no spurious bindings", async () => {
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `color(red). sound :- color(red).`,
        query: "sound.",
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers).toHaveLength(1);
        expect(result.answers[0].bindings).toEqual({});
        expect(result.answers[0].formatted).toBe("true");
      }
    });

    it("strips the leaked wrapper var while preserving a user binding of the same name", async () => {
      // The user binds `Err` to a real value but never mentions `EStr`. On the
      // unfixed engine the wrapper's `EStr` leaks as an extra binding (the
      // wrapper's `Err` happens to share the user's name and collapse onto the
      // user value, but `EStr` does not) — so base returns ['Err','EStr'].
      // The rename + strip leaves exactly the user's `Err` and drops `EStr`.
      solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: `holds(captured).`,
        query: "holds(Err).",
      });
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers).toHaveLength(1);
        expect(result.answers[0].bindings.Err).toBe("captured");
        expect(Object.keys(result.answers[0].bindings)).toEqual(["Err"]);
      }
    });
  });
});
