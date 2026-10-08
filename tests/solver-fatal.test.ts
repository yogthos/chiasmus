import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Fake WASM modules that fail the way Emscripten does: an abort calls the
// module's onAbort hook and then throws a RuntimeError("Aborted(...)"); a trap
// throws a RuntimeError without calling the hook.
const fake = vi.hoisted(() => ({
  z3: {
    onAbort: undefined as undefined | ((what: unknown) => void),
    failIn: null as
      | null
      | "mk_context_rc"
      | "solver_from_string"
      | "solver_check"
      | "model_eval"
      | "ast_vector_get",
    failure: "abort" as "abort" | "trap" | "recoverable" | "pthread-abort",
    checkResult: 0,
    calls: [] as string[],
  },
  prolog: {
    em: {} as { onAbort?: (what: unknown) => void },
    failure: "abort" as "abort" | "trap",
    initFails: false,
    calls: [] as string[],
  },
}));

const OOM = "Cannot enlarge memory arrays to size 2151104512 bytes (OOM)";

function wasmFailure(kind: "abort" | "trap", onAbort?: (what: unknown) => void): Error {
  if (kind === "trap") return new WebAssembly.RuntimeError("memory access out of bounds");
  onAbort?.(OOM);
  return new WebAssembly.RuntimeError(`Aborted(${OOM})`);
}

vi.mock("z3-solver", () => {
  const z3 = fake.z3;
  const call = (name: string, result: unknown = 0) => {
    z3.calls.push(name);
    if (z3.failIn === name) {
      if (z3.failure === "recoverable") throw new Error("canceled");
      throw wasmFailure(z3.failure, z3.onAbort);
    }
    return result;
  };
  return {
    init: async (overrides: { onAbort?: (what: unknown) => void } = {}) => {
      z3.onAbort = overrides.onAbort;
      return {
        Z3: {
          mk_config: () => call("mk_config", 1),
          mk_context_rc: () => call("mk_context_rc", 2),
          del_config: () => call("del_config"),
          set_ast_print_mode: () => call("set_ast_print_mode"),
          mk_solver: () => call("mk_solver", 3),
          solver_inc_ref: () => call("solver_inc_ref"),
          solver_dec_ref: () => call("solver_dec_ref"),
          del_context: () => call("del_context"),
          solver_from_string: () => call("solver_from_string"),
          get_error_code: () => call("get_error_code", 0),
          solver_check: async () => {
            if (z3.failIn === "solver_check" && z3.failure === "pthread-abort") {
              // An abort on the check's pthread reaches the main thread as a
              // proxied onAbort call; the check's promise never settles.
              z3.calls.push("solver_check");
              setTimeout(() => z3.onAbort?.(OOM), 10);
              return new Promise(() => undefined);
            }
            return call("solver_check", z3.checkResult);
          },
          // Model and unsat-core extraction: one constant `x`, one core label.
          solver_get_model: () => call("solver_get_model", 4),
          model_inc_ref: () => call("model_inc_ref"),
          model_dec_ref: () => call("model_dec_ref"),
          model_get_num_consts: () => call("model_get_num_consts", 1),
          model_get_const_decl: () => call("model_get_const_decl", 5),
          model_get_num_funcs: () => call("model_get_num_funcs", 0),
          get_decl_name: () => call("get_decl_name", 6),
          get_symbol_kind: () => call("get_symbol_kind", 1),
          get_symbol_string: () => call("get_symbol_string", "x"),
          get_arity: () => call("get_arity", 0),
          mk_app: () => call("mk_app", 7),
          inc_ref: () => call("inc_ref"),
          dec_ref: () => call("dec_ref"),
          model_eval: () => call("model_eval", 8),
          ast_to_string: () => call("ast_to_string", "1"),
          solver_get_unsat_core: () => call("solver_get_unsat_core", 9),
          ast_vector_inc_ref: () => call("ast_vector_inc_ref"),
          ast_vector_dec_ref: () => call("ast_vector_dec_ref"),
          ast_vector_size: () => call("ast_vector_size", 1),
          ast_vector_get: () => call("ast_vector_get", 10),
        },
      };
    },
    Z3_ast_print_mode: { Z3_PRINT_SMTLIB2_COMPLIANT: 2 },
    Z3_error_code: { Z3_OK: 0 },
    Z3_lbool: { Z3_L_FALSE: -1, Z3_L_UNDEF: 0, Z3_L_TRUE: 1 },
    Z3_symbol_kind: { Z3_INT_SYMBOL: 0, Z3_STRING_SYMBOL: 1 },
  };
});

vi.mock("prolog-wasm-full", () => {
  const pl = fake.prolog;
  const query = (goal: string) => ({
    all: () => {
      pl.calls.push(`query:${goal}`);
      return [];
    },
    forEach: () => {
      pl.calls.push(`query:${goal}`);
      if (goal.includes("call_with_inference_limit")) {
        throw wasmFailure(pl.failure, pl.em.onAbort);
      }
    },
    close: () => void pl.calls.push("close"),
  });
  return {
    initProlog: async () => {
      pl.em = {
        FS: {
          writeFile: () => void pl.calls.push("writeFile"),
          unlink: () => void pl.calls.push("unlink"),
        },
      } as typeof pl.em;
      return {
        em: pl.em,
        consult: () => {
          pl.calls.push("consult");
          if (pl.initFails) throw wasmFailure("trap");
        },
        stock: {
          call: (goal: string) => {
            pl.calls.push(`call:${goal}`);
            return true;
          },
        },
        query,
      };
    },
  };
});

type Fatal = typeof import("../src/solvers/fatal.js");

async function loadZ3(): Promise<{ fatal: Fatal; z3: typeof import("../src/solvers/z3-solver.js") }> {
  return {
    fatal: await import("../src/solvers/fatal.js"),
    z3: await import("../src/solvers/z3-solver.js"),
  };
}

async function solveZ3(z3: typeof import("../src/solvers/z3-solver.js")) {
  const solver = await z3.createZ3Solver();
  try {
    return await solver.solve({ type: "z3", smtlib: "(declare-const x Int)" });
  } finally {
    solver.dispose();
  }
}

beforeEach(() => {
  // Poisoned state lives in module scope; every test gets fresh modules.
  vi.resetModules();
  fake.z3.calls = [];
  fake.z3.failIn = null;
  fake.z3.failure = "abort";
  fake.z3.checkResult = 0;
  fake.prolog.calls = [];
  fake.prolog.failure = "abort";
  fake.prolog.initFails = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isFatalWasmError", () => {
  it("recognises Emscripten aborts and WASM traps only", async () => {
    const { abortError, isFatalWasmError } = await import("../src/solvers/fatal.js");

    expect(isFatalWasmError(new WebAssembly.RuntimeError("memory access out of bounds"))).toBe(true);
    expect(isFatalWasmError(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isFatalWasmError(new WebAssembly.RuntimeError(`Aborted(${OOM})`))).toBe(true);
    // Solver messages echo user input, so the text alone proves nothing.
    expect(isFatalWasmError(new Error(`Aborted(${OOM})`))).toBe(false);
    expect(isFatalWasmError(`Aborted(${OOM})`)).toBe(false);
    expect(isFatalWasmError(abortError(OOM))).toBe(true);
    expect(isFatalWasmError(new Error("(error \"line 1 column 5: Sort mismatch\")"))).toBe(false);
    expect(isFatalWasmError(new Error("canceled"))).toBe(false);
    expect(isFatalWasmError(undefined)).toBe(false);
  });
});

describe("exitOnFatalSolverError", () => {
  it("logs to stderr and exits with code 1", async () => {
    const { exitOnFatalSolverError, reportFatalSolverError } = await import("../src/solvers/fatal.js");
    const exit = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    exitOnFatalSolverError(exit);
    reportFatalSolverError("z3", new Error(`Aborted(${OOM})`));

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`fatal z3 WASM error`));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(OOM));
  });
});

describe("Z3 fatal WASM errors", () => {
  it("reports an abort while creating the context and never calls into Z3 again", async () => {
    const { fatal, z3 } = await loadZ3();
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    fake.z3.failIn = "mk_context_rc";

    const first = await solveZ3(z3);

    expect(first).toEqual({ status: "error", error: `Aborted(${OOM})` });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("z3");
    expect((handler.mock.calls[0][1] as Error).message).toContain("Aborted(");

    const callsAfterAbort = fake.z3.calls.length;
    const second = await solveZ3(z3);

    expect(second.status).toBe("error");
    if (second.status === "error") expect(second.error).toMatch(/restart/);
    expect(fake.z3.calls.length).toBe(callsAfterAbort);
    expect(handler).toHaveBeenCalledOnce();
    await expect(z3.z3AllocatedBytes()).rejects.toThrow("Aborted(");
  });

  it("reports a trap and skips cleanup calls into the broken module", async () => {
    const { fatal, z3 } = await loadZ3();
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    fake.z3.failIn = "solver_from_string";
    fake.z3.failure = "trap";

    const first = await solveZ3(z3);

    expect(first).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(handler).toHaveBeenCalledOnce();
    expect(fake.z3.calls.at(-1)).toBe("solver_from_string");
  });

  it("does not exit without a handler but still fails fast afterwards", async () => {
    const { z3 } = await loadZ3();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    fake.z3.failIn = "solver_check";
    fake.z3.failure = "abort";

    const first = await solveZ3(z3);
    const callsAfterAbort = fake.z3.calls.length;
    const second = await solveZ3(z3);

    expect(first.status).toBe("error");
    expect(second.status).toBe("error");
    if (second.status === "error") expect(second.error).toContain(OOM);
    expect(fake.z3.calls.length).toBe(callsAfterAbort);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits through the entry-point handler on an abort", async () => {
    const { fatal, z3 } = await loadZ3();
    const exit = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fatal.exitOnFatalSolverError(exit);
    fake.z3.failIn = "solver_check";
    fake.z3.failure = "abort";

    await solveZ3(z3);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("ends a check whose pthread aborted, and the solves queued behind it", async () => {
    const { fatal, z3 } = await loadZ3();
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    fake.z3.failIn = "solver_check";
    fake.z3.failure = "pthread-abort";

    const [first, queued] = await Promise.all([solveZ3(z3), solveZ3(z3)]);

    expect(first).toEqual({ status: "error", error: `Aborted(${OOM})` });
    expect(queued.status).toBe("error");
    if (queued.status === "error") expect(queued.error).toMatch(/restart/);
    expect(handler).toHaveBeenCalledOnce();
  });

  for (const [step, checkResult] of [["model_eval", 1], ["ast_vector_get", -1]] as const) {
    for (const failure of ["trap", "abort"] as const) {
      it(`makes no call into Z3 after ${failure === "abort" ? "an" : "a"} ${failure} in ${step} during result extraction`, async () => {
        const { fatal, z3 } = await loadZ3();
        const handler = vi.fn();
        fatal.setFatalSolverErrorHandler(handler);
        fake.z3.checkResult = checkResult;
        fake.z3.failIn = step;
        fake.z3.failure = failure;

        const first = await solveZ3(z3);
        const callsAfterFailure = fake.z3.calls.length;
        const second = await solveZ3(z3);

        expect(first.status).toBe("error");
        expect(fake.z3.calls.at(-1)).toBe(step);
        expect(handler).toHaveBeenCalledOnce();
        expect(second.status).toBe("error");
        expect(fake.z3.calls.length).toBe(callsAfterFailure);
      });
    }
  }

  it("still releases references after an ordinary extraction error", async () => {
    const { z3 } = await loadZ3();
    fake.z3.checkResult = 1;
    fake.z3.failIn = "model_eval";
    fake.z3.failure = "recoverable";

    const result = await solveZ3(z3);

    expect(result).toEqual({ status: "error", error: "Model extraction failed: canceled" });
    expect(fake.z3.calls.slice(-4)).toEqual(["dec_ref", "model_dec_ref", "solver_dec_ref", "del_context"]);
  });

  it("treats an ordinary solver error as recoverable", async () => {
    const { fatal, z3 } = await loadZ3();
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    fake.z3.failIn = "solver_check";
    fake.z3.failure = "recoverable";

    const first = await solveZ3(z3);
    fake.z3.failIn = null;
    const second = await solveZ3(z3);

    expect(first).toEqual({ status: "error", error: "canceled" });
    expect(second.status).toBe("unknown");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("Prolog fatal WASM errors", () => {
  async function solveProlog(prolog: typeof import("../src/solvers/prolog-solver.js")) {
    const solver = prolog.createPrologSolver();
    try {
      return await solver.solve({ type: "prolog", program: "p(1).", query: "p(X)." });
    } finally {
      solver.dispose();
    }
  }

  for (const [failure, name] of [["abort", "an abort"], ["trap", "a trap"]] as const) {
    it(`reports ${name} and never calls into SWI again`, async () => {
      const fatal = await import("../src/solvers/fatal.js");
      const prolog = await import("../src/solvers/prolog-solver.js");
      const handler = vi.fn();
      fatal.setFatalSolverErrorHandler(handler);
      fake.prolog.failure = failure;

      const first = await solveProlog(prolog);

      expect(first.status).toBe("error");
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toBe("prolog");
      // The failing query is the last call: no cleanup on the broken module.
      expect(fake.prolog.calls.at(-1)).toContain("call_with_inference_limit");

      const callsAfterFailure = fake.prolog.calls.length;
      const second = await solveProlog(prolog);

      expect(second.status).toBe("error");
      if (second.status === "error") expect(second.error).toMatch(/restart/);
      expect(fake.prolog.calls.length).toBe(callsAfterFailure);
      expect(handler).toHaveBeenCalledOnce();
    });

    it(`does not run a solve that waited for the module through ${name}`, async () => {
      const fatal = await import("../src/solvers/fatal.js");
      const prolog = await import("../src/solvers/prolog-solver.js");
      const handler = vi.fn();
      fatal.setFatalSolverErrorHandler(handler);
      fake.prolog.failure = failure;

      // Both solves wait for the module; the first one breaks it.
      const [first, second] = await Promise.all([solveProlog(prolog), solveProlog(prolog)]);

      expect(first.status).toBe("error");
      if (first.status === "error") expect(first.error).not.toMatch(/restart/);
      expect(second.status).toBe("error");
      if (second.status === "error") expect(second.error).toMatch(/restart/);
      expect(fake.prolog.calls.at(-1)).toContain("call_with_inference_limit");
      expect(fake.prolog.calls.filter((c) => c === "writeFile")).toHaveLength(1);
      expect(handler).toHaveBeenCalledOnce();
    });
  }

  it("reports a trap while loading the module", async () => {
    const fatal = await import("../src/solvers/fatal.js");
    const prolog = await import("../src/solvers/prolog-solver.js");
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    fake.prolog.initFails = true;

    const first = await solveProlog(prolog);
    const second = await solveProlog(prolog);

    expect(first).toEqual({ status: "error", error: "prolog init failed: memory access out of bounds" });
    expect(second.status).toBe("error");
    if (second.status === "error") expect(second.error).toMatch(/restart/);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("prolog");
  });
});
