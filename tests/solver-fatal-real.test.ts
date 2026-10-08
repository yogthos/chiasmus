import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { setFatalSolverErrorHandler } from "../src/solvers/fatal.js";
import type { SolverResult } from "../src/solvers/types.js";

// The real z3-solver and prolog-wasm-full modules, no fakes: these check
// that a real crash reaches our code as a fatal error instead of being
// swallowed, which tests/solver-fatal.test.ts can only assume.

async function solveZ3(smtlib: string): Promise<SolverResult> {
  const solver = await createZ3Solver();
  try {
    return await solver.solve({ type: "z3", smtlib });
  } finally {
    solver.dispose();
  }
}

afterEach(() => {
  setFatalSolverErrorHandler(null);
});

describe("ordinary solver errors stay recoverable", () => {
  it("does not treat an error that echoes 'Aborted(' from user input as fatal", async () => {
    const handler = vi.fn();
    setFatalSolverErrorHandler(handler);

    // Model extraction fails on a function in the model, and its message
    // quotes the user's declaration.
    const result = await solveZ3(`(declare-fun |Aborted(| (Int) Int)
(assert (= (|Aborted(| 1) 2))`);
    const next = await solveZ3("(declare-const x Int) (assert (= x 3))");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(/^Model extraction failed: Incorrect number of arguments to/);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(next).toEqual({ status: "sat", model: { x: "3" } });
  });
});

// Both modules marshal string arguments onto the Emscripten stack, so an
// oversized input overflows it and traps with "memory access out of bounds" —
// a real, fast and deterministic crash. If a dependency upgrade stops these
// inputs from trapping, these tests fail at the first status check; find
// another input that crashes the module rather than deleting them.
describe("real WASM crashes", () => {
  // A crash leaves the solver unusable for the rest of the process, so each
  // test loads its own copy of the solver modules.
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports a Z3 trap, fails the queued solve, and fails fast afterwards", async () => {
    const fatal = await import("../src/solvers/fatal.js");
    const z3 = await import("../src/solvers/z3-solver.js");
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    const solve = async (smtlib: string) => {
      const solver = await z3.createZ3Solver();
      try {
        return await solver.solve({ type: "z3", smtlib });
      } finally {
        solver.dispose();
      }
    };

    // z3-solver copies the input onto a 20 MiB stack.
    const oversized = `; ${"x".repeat(24 * 1024 * 1024)}\n(declare-const x Int)`;
    const [crashed, queued] = await Promise.all([
      solve(oversized),
      solve("(declare-const x Int) (assert (= x 1))"),
    ]);
    const later = await solve("(declare-const x Int) (assert (= x 2))");

    expect(crashed).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("z3");
    expect(handler.mock.calls[0][1]).toBeInstanceOf(WebAssembly.RuntimeError);
    for (const result of [queued, later]) {
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toMatch(/unavailable.*restart the process/);
    }
  });

  it("reports a Prolog trap, stops the solve waiting on it, and fails fast afterwards", async () => {
    const fatal = await import("../src/solvers/fatal.js");
    const prolog = await import("../src/solvers/prolog-solver.js");
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    const solve = async (query: string) => {
      const solver = prolog.createPrologSolver();
      try {
        return await solver.solve({ type: "prolog", program: "p(1).", query });
      } finally {
        solver.dispose();
      }
    };

    // Queries of 1M characters still pass; 2M already trap.
    const oversized = `atom_length('${"a".repeat(4_000_000)}', L).`;
    const [crashed, waiting] = await Promise.all([solve(oversized), solve("p(X).")]);
    const later = await solve("p(X).");

    expect(crashed).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("prolog");
    expect(handler.mock.calls[0][1]).toBeInstanceOf(WebAssembly.RuntimeError);
    for (const result of [waiting, later]) {
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toMatch(/unavailable.*restart the process/);
    }
  });
});
