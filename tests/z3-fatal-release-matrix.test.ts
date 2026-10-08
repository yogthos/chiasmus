import { describe, it, expect, vi } from "vitest";

// Injects a WASM failure at every call a successful solve makes, including
// the reference releases in its cleanup, and checks that nothing calls back
// into the module afterwards. A generic fake answers every Z3 function, so
// the call sequence comes from the solver itself rather than from this file.
const fake = vi.hoisted(() => ({
  checkResult: 1,
  calls: [] as string[],
  failAt: -1,
  abort: false,
  onAbort: undefined as undefined | ((what: unknown) => void),
}));

vi.mock("z3-solver", () => ({
  Z3_ast_print_mode: { Z3_PRINT_SMTLIB2_COMPLIANT: 2 },
  Z3_error_code: { Z3_OK: 0 },
  Z3_lbool: { Z3_L_FALSE: -1, Z3_L_UNDEF: 0, Z3_L_TRUE: 1 },
  Z3_symbol_kind: { Z3_INT_SYMBOL: 0, Z3_STRING_SYMBOL: 1 },
  init: async (overrides: { onAbort?: (what: unknown) => void } = {}) => {
    fake.onAbort = overrides.onAbort;
    const call = (name: string) => {
      fake.calls.push(name);
      if (fake.calls.length - 1 === fake.failAt) {
        if (fake.abort) fake.onAbort?.("injected abort");
        throw new WebAssembly.RuntimeError(fake.abort ? "Aborted(injected abort)" : "injected trap");
      }
      if (name === "solver_check") return Promise.resolve(fake.checkResult);
      if (["get_error_code", "get_arity", "model_get_num_funcs", "get_symbol_kind"].includes(name)) return 0;
      if (name === "ast_to_string") return "1";
      return 1;
    };
    return { Z3: new Proxy({}, { get: (_target, key) => () => call(String(key)) }) };
  },
}));

const input = { type: "z3" as const, smtlib: "(assert true)" };

async function freshSolver(failAt: number, abort: boolean) {
  // Poisoned state lives in module scope; every injection gets fresh modules.
  vi.resetModules();
  fake.calls = [];
  fake.failAt = failAt;
  fake.abort = abort;
  const fatal = await import("../src/solvers/fatal.js");
  const handler = vi.fn();
  fatal.setFatalSolverErrorHandler(handler);
  const { createZ3Solver } = await import("../src/solvers/z3-solver.js");
  return { solver: await createZ3Solver(), handler };
}

describe("Z3 fatal WASM errors at every call position", () => {
  for (const [label, checkResult] of [["sat", 1], ["unsat", -1]] as const) {
    it(`never calls into Z3 after a failure anywhere in a ${label} solve`, async () => {
      const { solver: baseline } = await freshSolver(-1, false);
      fake.checkResult = checkResult;
      await baseline.solve(input);
      const sequence = [...fake.calls];
      expect(sequence).toContain("del_context");

      for (const abort of [false, true]) {
        for (let i = 0; i < sequence.length; i++) {
          const where = `${abort ? "abort" : "trap"} at ${i} (${sequence[i]})`;
          const { solver, handler } = await freshSolver(i, abort);

          const result = await solver.solve(input);
          await solver.solve(input);

          expect(result.status, where).toBe("error");
          expect(fake.calls, where).toEqual(sequence.slice(0, i + 1));
          expect(handler, where).toHaveBeenCalledOnce();
        }
      }
    });
  }
});
