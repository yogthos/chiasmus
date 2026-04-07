import { describe, it, expect, afterEach } from "vitest";
import { SolverSession } from "../src/solvers/session.js";

describe("SolverSession", () => {
  const sessions: SolverSession[] = [];

  afterEach(() => {
    for (const s of sessions) s.dispose();
    sessions.length = 0;
  });

  function track(s: SolverSession) {
    sessions.push(s);
    return s;
  }

  it("creates isolated Z3 sessions", async () => {
    const s1 = track(await SolverSession.create("z3"));
    const s2 = track(await SolverSession.create("z3"));

    expect(s1.id).not.toBe(s2.id);

    const r1 = await s1.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (= x 42))
      `,
    });

    const r2 = await s2.solve({
      type: "z3",
      smtlib: `
        (declare-const x Int)
        (assert (= x 99))
      `,
    });

    expect(r1.status).toBe("sat");
    expect(r2.status).toBe("sat");
    if (r1.status === "sat" && r2.status === "sat") {
      expect(r1.model.x).toBe("42");
      expect(r2.model.x).toBe("99");
    }
  });

  it("creates isolated Prolog sessions", async () => {
    const s1 = track(await SolverSession.create("prolog"));
    const s2 = track(await SolverSession.create("prolog"));

    expect(s1.id).not.toBe(s2.id);

    const r1 = await s1.solve({
      type: "prolog",
      program: "fact(a).",
      query: "fact(X).",
    });

    const r2 = await s2.solve({
      type: "prolog",
      program: "fact(b). fact(c).",
      query: "fact(X).",
    });

    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    if (r1.status === "success" && r2.status === "success") {
      expect(r1.answers).toHaveLength(1);
      expect(r1.answers[0].bindings.X).toBe("a");
      expect(r2.answers).toHaveLength(2);
    }
  });

  it("runs Z3 and Prolog concurrently without interference", async () => {
    const z3Session = track(await SolverSession.create("z3"));
    const plSession = track(await SolverSession.create("prolog"));

    const [z3Result, plResult] = await Promise.all([
      z3Session.solve({
        type: "z3",
        smtlib: `
          (declare-const a Int)
          (declare-const b Int)
          (assert (= (+ a b) 10))
          (assert (> a 0))
          (assert (> b 0))
        `,
      }),
      plSession.solve({
        type: "prolog",
        program: `
          add(0, Y, Y).
          add(s(X), Y, s(Z)) :- add(X, Y, Z).
        `,
        query: "add(s(s(0)), s(s(s(0))), R).",
      }),
    ]);

    expect(z3Result.status).toBe("sat");
    expect(plResult.status).toBe("success");
    if (z3Result.status === "sat") {
      const a = parseInt(z3Result.model.a, 10);
      const b = parseInt(z3Result.model.b, 10);
      expect(a + b).toBe(10);
    }
    if (plResult.status === "success") {
      expect(plResult.answers).toHaveLength(1);
      expect(plResult.answers[0].bindings.R).toBe("s(s(s(s(s(0)))))");
    }
  });

  it("assigns unique session IDs", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const s = track(await SolverSession.create("prolog"));
      ids.add(s.id);
    }
    expect(ids.size).toBe(5);
  });
});
