import { describe, it, expect } from "vitest";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { createPrologSolver } from "../src/solvers/prolog-solver.js";

describe("Dogfood: realistic problem domains", () => {
  describe("Z3: Policy contradiction detection", () => {
    it("detects that 3 tasks cannot fit in 2 non-overlapping slots", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
            (declare-const task1_slot Int)
            (declare-const task2_slot Int)
            (declare-const task3_slot Int)
            (assert (or (= task1_slot 1) (= task1_slot 2)))
            (assert (or (= task2_slot 1) (= task2_slot 2)))
            (assert (or (= task3_slot 1) (= task3_slot 2)))
            (assert (not (= task1_slot task2_slot)))
            (assert (not (= task2_slot task3_slot)))
            (assert (not (= task1_slot task3_slot)))
          `,
        });
        // Pigeonhole: 3 tasks, 2 slots, all must differ → UNSAT
        expect(result.status).toBe("unsat");
      } finally {
        solver.dispose();
      }
    });

    it("finds valid dependency version resolution", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
            (declare-const lib_a Int)
            (declare-const lib_b Int)
            (declare-const lib_c Int)
            (assert (and (>= lib_a 1) (<= lib_a 3)))
            (assert (and (>= lib_b 1) (<= lib_b 2)))
            (assert (and (>= lib_c 1) (<= lib_c 3)))
            ; App requires A >= 2
            (assert (>= lib_a 2))
            ; A@3 requires B >= 2
            (assert (=> (= lib_a 3) (>= lib_b 2)))
            ; B@2 requires C >= 2
            (assert (=> (= lib_b 2) (>= lib_c 2)))
            ; C@3 incompatible with A@2
            (assert (not (and (= lib_c 3) (= lib_a 2))))
          `,
        });
        expect(result.status).toBe("sat");
        if (result.status === "sat") {
          const a = parseInt(result.model.lib_a, 10);
          const b = parseInt(result.model.lib_b, 10);
          const c = parseInt(result.model.lib_c, 10);
          expect(a).toBeGreaterThanOrEqual(2);
          expect(b).toBeGreaterThanOrEqual(1);
          expect(c).toBeGreaterThanOrEqual(1);
          // Verify constraint: C@3 not with A@2
          expect(!(c === 3 && a === 2)).toBe(true);
        }
      } finally {
        solver.dispose();
      }
    });

    it("detects contradictory firewall rules", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
            (declare-datatypes ((Verdict 0)) (((Allow) (Deny))))
            (declare-const port Int)
            (declare-const rule1_verdict Verdict)
            (declare-const rule2_verdict Verdict)

            ; Rule 1: allow port 80-443
            (assert (=> (and (>= port 80) (<= port 443))
                       (= rule1_verdict Allow)))
            ; Rule 2: deny port 100-200
            (assert (=> (and (>= port 100) (<= port 200))
                       (= rule2_verdict Deny)))

            ; Find a port where both rules fire with conflicting verdicts
            (assert (= rule1_verdict Allow))
            (assert (= rule2_verdict Deny))
            (assert (and (>= port 80) (<= port 443)))
            (assert (and (>= port 100) (<= port 200)))
          `,
        });
        // Should be SAT: ports 100-200 are in both ranges
        expect(result.status).toBe("sat");
        if (result.status === "sat") {
          const port = parseInt(result.model.port, 10);
          expect(port).toBeGreaterThanOrEqual(100);
          expect(port).toBeLessThanOrEqual(200);
        }
      } finally {
        solver.dispose();
      }
    });
  });

  describe("Prolog: Rule-based reasoning", () => {
    it("derives transitive permissions through role hierarchy", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
            role(alice, admin).
            role(bob, editor).
            role(carol, viewer).

            inherits(admin, editor).
            inherits(editor, viewer).

            has_role(User, Role) :- role(User, Role).
            has_role(User, Role) :- role(User, R), inherits(R, Mid), has_role_chain(Mid, Role).

            has_role_chain(Role, Role).
            has_role_chain(Start, End) :- inherits(Start, Mid), has_role_chain(Mid, End).

            can(User, read) :- has_role(User, viewer).
            can(User, read) :- has_role(User, editor).
            can(User, read) :- has_role(User, admin).
            can(User, write) :- has_role(User, editor).
            can(User, write) :- has_role(User, admin).
            can(User, delete) :- has_role(User, admin).
          `,
          query: "can(alice, Action).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const actions = result.answers.map((a) => a.bindings.Action);
          // Admin inherits editor inherits viewer, so alice can do all
          expect(actions).toContain("read");
          expect(actions).toContain("write");
          expect(actions).toContain("delete");
        }
      } finally {
        solver.dispose();
      }
    });

    it("checks data lineage / reachability", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
            flows(user_input, api_handler).
            flows(api_handler, validator).
            flows(validator, database).
            flows(api_handler, logger).
            flows(logger, log_file).

            reaches(A, B) :- flows(A, B).
            reaches(A, B) :- flows(A, Mid), reaches(Mid, B).
          `,
          query: "reaches(user_input, Where).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const destinations = result.answers.map((a) => a.bindings.Where);
          expect(destinations).toContain("database");
          expect(destinations).toContain("log_file");
          expect(destinations).toContain("api_handler");
        }
      } finally {
        solver.dispose();
      }
    });

    it("validates workflow state machine transitions", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
            transition(draft, submit, pending_review).
            transition(pending_review, approve, approved).
            transition(pending_review, reject, draft).
            transition(approved, publish, published).
            transition(published, archive, archived).

            can_reach(State, Target) :- transition(State, _, Target).
            can_reach(State, Target) :- transition(State, _, Mid), can_reach(Mid, Target).

            valid_path(From, To, [Action]) :- transition(From, Action, To).
            valid_path(From, To, [Action|Rest]) :- transition(From, Action, Mid), valid_path(Mid, To, Rest).
          `,
          query: "can_reach(draft, published).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          // draft → pending_review → approved → published: reachable
          expect(result.answers.length).toBeGreaterThanOrEqual(1);
        }
      } finally {
        solver.dispose();
      }
    });
  });
});
