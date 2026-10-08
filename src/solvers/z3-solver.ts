import {
  init,
  Z3_ast_print_mode,
  Z3_error_code,
  Z3_lbool,
  Z3_symbol_kind,
  type Z3_context,
  type Z3_func_decl,
  type Z3_model,
  type Z3_solver,
} from "z3-solver";
import { abortError, isFatalWasmError, reportFatalSolverError, rethrowIfFatal } from "./fatal.js";
import type { Solver, SolverInput, SolverResult } from "./types.js";

type Z3Core = Awaited<ReturnType<typeof init>>["Z3"];

// Cache Z3 WASM initialization — it loads ~30MB, should only happen once.
let z3Promise: ReturnType<typeof init> | null = null;

// Set once the WASM module aborts or traps. Nothing may call into it after
// that: its heap and locks are left mid-update, and calling back in can block
// the event loop for good.
let fatalError: Error | null = null;

// Fails the check in flight (solves are serialized, so there is at most one).
// An abort on check()'s pthread leaves Z3's promise pending forever; this ends
// that solve, and with it the solves queued behind it.
let failPendingCheck: ((e: Error) => void) | null = null;

function markFatal(e: unknown): void {
  if (fatalError) return;
  fatalError = e instanceof Error ? e : new Error(String(e));
  failPendingCheck?.(fatalError);
  reportFatalSolverError("z3", fatalError);
}

function unavailable(error: Error): SolverResult {
  return {
    status: "error",
    error: `Z3 is unavailable after a fatal WASM error (${error.message}); restart the process`,
  };
}

function getZ3() {
  if (!z3Promise) {
    z3Promise = init({
      // Emscripten calls this before unwinding an abort, from the main thread
      // or proxied from a pthread, so the process can still exit cleanly.
      onAbort: (what: unknown) => markFatal(abortError(what)),
    });
  }
  return z3Promise;
}

/**
 * Bytes Z3 currently has allocated inside its WASM heap. The heap is a fixed
 * 2 GiB that Emscripten never grows, so this — not the heap size — shows a
 * leak. Exported for diagnostics and tests.
 */
export async function z3AllocatedBytes(): Promise<number> {
  const z3 = await getZ3();
  if (fatalError) throw fatalError;
  return Number(z3.Z3.get_estimated_alloc_size());
}

/** Default per-check timeout in ms. Protects the server from pathological inputs. */
const DEFAULT_Z3_TIMEOUT_MS = 30_000;

/** Strip commands that we handle ourselves to avoid conflicts */
function sanitizeSmtlib(input: string): string {
  return input
    .replace(/\(\s*(?:check-sat|get-model|get-unsat-core|exit|set-option\s+:produce-unsat-cores\s+\w+)\s*\)/g, "")
    .trim();
}

/**
 * Sanitize and inject a default `(set-option :timeout ...)` if the caller
 * did not provide one. Exported for testing.
 */
export function prepareSmtlib(input: string): string {
  const sanitized = sanitizeSmtlib(input);
  if (!sanitized) return sanitized;
  if (/\(\s*set-option\s+:timeout\s+\d+\s*\)/.test(sanitized)) {
    return sanitized;
  }
  return `(set-option :timeout ${DEFAULT_Z3_TIMEOUT_MS})\n${sanitized}`;
}

// Z3's check() runs on an Emscripten pthread and the low-level API accepts
// only one such call at a time, so solves run one after another.
let solveQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = solveQueue.then(fn);
  solveQueue = run.catch(() => undefined);
  return run;
}

function throwIfError(Z3: Z3Core, ctx: Z3_context): void {
  const code = Z3.get_error_code(ctx);
  if (code !== Z3_error_code.Z3_OK) {
    throw new Error(Z3.get_error_msg(ctx, code));
  }
}

// Called from a catch, so the module is marked dead before the finally
// blocks below run: a WASM failure during extraction must not call back into
// it to release references.
function markIfFatal(e: unknown): void {
  if (isFatalWasmError(e)) markFatal(e);
}

function readUnsatCore(Z3: Z3Core, ctx: Z3_context, solver: Z3_solver): string[] {
  const core = Z3.solver_get_unsat_core(ctx, solver);
  throwIfError(Z3, ctx);
  Z3.ast_vector_inc_ref(ctx, core);
  try {
    const labels: string[] = [];
    const size = Z3.ast_vector_size(ctx, core);
    for (let i = 0; i < size; i++) {
      labels.push(Z3.ast_to_string(ctx, Z3.ast_vector_get(ctx, core, i)));
    }
    return labels;
  } catch (e: unknown) {
    markIfFatal(e);
    throw e;
  } finally {
    if (!fatalError) Z3.ast_vector_dec_ref(ctx, core);
  }
}

function evalConstant(
  Z3: Z3Core,
  ctx: Z3_context,
  model: Z3_model,
  decl: Z3_func_decl,
): string {
  if (Z3.get_arity(ctx, decl) !== 0) {
    const shown = Z3.ast_to_string(ctx, Z3.func_decl_to_ast(ctx, decl));
    throw new Error(`Incorrect number of arguments to ${shown}`);
  }
  const app = Z3.mk_app(ctx, decl, []);
  throwIfError(Z3, ctx);
  Z3.inc_ref(ctx, app);
  try {
    const value = Z3.model_eval(ctx, model, app, false);
    throwIfError(Z3, ctx);
    if (value === null) {
      throw new Error("Failed to evaluate expression in the model");
    }
    Z3.inc_ref(ctx, value);
    try {
      return Z3.ast_to_string(ctx, value);
    } catch (e: unknown) {
      markIfFatal(e);
      throw e;
    } finally {
      if (!fatalError) Z3.dec_ref(ctx, value);
    }
  } catch (e: unknown) {
    markIfFatal(e);
    throw e;
  } finally {
    if (!fatalError) Z3.dec_ref(ctx, app);
  }
}

function readModel(Z3: Z3Core, ctx: Z3_context, solver: Z3_solver): Record<string, string> {
  const model = Z3.solver_get_model(ctx, solver);
  throwIfError(Z3, ctx);
  Z3.model_inc_ref(ctx, model);
  try {
    // Constants first, then functions — the order model.decls() used.
    const decls: Z3_func_decl[] = [];
    const numConsts = Z3.model_get_num_consts(ctx, model);
    for (let i = 0; i < numConsts; i++) decls.push(Z3.model_get_const_decl(ctx, model, i));
    const numFuncs = Z3.model_get_num_funcs(ctx, model);
    for (let i = 0; i < numFuncs; i++) decls.push(Z3.model_get_func_decl(ctx, model, i));

    const assignments: Record<string, string> = {};
    for (const decl of decls) {
      const symbol = Z3.get_decl_name(ctx, decl);
      const name = Z3.get_symbol_kind(ctx, symbol) === Z3_symbol_kind.Z3_INT_SYMBOL
        ? String(Z3.get_symbol_int(ctx, symbol))
        : Z3.get_symbol_string(ctx, symbol);
      assignments[name] = evalConstant(Z3, ctx, model, decl);
    }
    return assignments;
  } catch (e: unknown) {
    markIfFatal(e);
    throw e;
  } finally {
    if (!fatalError) Z3.model_dec_ref(ctx, model);
  }
}

async function checkSmtlib(
  Z3: Z3Core,
  ctx: Z3_context,
  solver: Z3_solver,
  smtlib: string,
): Promise<SolverResult> {
  Z3.solver_from_string(ctx, solver, `(set-option :produce-unsat-cores true)\n${smtlib}`);
  const parseError = Z3.get_error_code(ctx);
  if (parseError !== Z3_error_code.Z3_OK) {
    return { status: "error", error: Z3.get_error_msg(ctx, parseError) };
  }

  let checkResult: Z3_lbool;
  try {
    checkResult = await new Promise<Z3_lbool>((resolve, reject) => {
      failPendingCheck = reject;
      Z3.solver_check(ctx, solver).then(resolve, reject);
    }).finally(() => {
      failPendingCheck = null;
    });
  } catch (e: unknown) {
    rethrowIfFatal(e);
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", error: msg };
  }

  if (checkResult === Z3_lbool.Z3_L_FALSE) {
    try {
      return { status: "unsat", unsatCore: readUnsatCore(Z3, ctx, solver) };
    } catch (e: unknown) {
      rethrowIfFatal(e);
      return { status: "unsat", unsatCore: [] };
    }
  }

  if (checkResult !== Z3_lbool.Z3_L_TRUE) {
    return { status: "unknown" };
  }

  try {
    return { status: "sat", model: readModel(Z3, ctx, solver) };
  } catch (e: unknown) {
    rethrowIfFatal(e);
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", error: `Model extraction failed: ${msg}` };
  }
}

/**
 * Solve in a context of its own and delete it before returning.
 *
 * Solves must not share a context: Z3 keeps named assertions and define-funs
 * at context level and can add them to later models. The context is deleted
 * explicitly, so only the low-level API touches it — the high-level wrappers
 * free their objects from a FinalizationRegistry, which never frees the
 * context (~8.7 MB per call) and would run after the delete.
 */
async function solveInFreshContext(Z3: Z3Core, smtlib: string): Promise<SolverResult> {
  const cfg = Z3.mk_config();
  const ctx = Z3.mk_context_rc(cfg);
  Z3.del_config(cfg);
  let solver: Z3_solver | null = null;
  try {
    Z3.set_ast_print_mode(ctx, Z3_ast_print_mode.Z3_PRINT_SMTLIB2_COMPLIANT);
    solver = Z3.mk_solver(ctx);
    Z3.solver_inc_ref(ctx, solver);
    return await checkSmtlib(Z3, ctx, solver, smtlib);
  } catch (e: unknown) {
    if (isFatalWasmError(e)) markFatal(e);
    throw e;
  } finally {
    if (!fatalError) {
      if (solver !== null) Z3.solver_dec_ref(ctx, solver);
      Z3.del_context(ctx);
    }
  }
}

async function solveUnlessFatal(Z3: Z3Core, smtlib: string): Promise<SolverResult> {
  if (fatalError) return unavailable(fatalError);
  try {
    return await solveInFreshContext(Z3, smtlib);
  } catch (e: unknown) {
    if (!isFatalWasmError(e)) throw e;
    markFatal(e);
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createZ3Solver(): Promise<Solver> {
  const z3 = await getZ3();
  let disposed = false;

  return {
    type: "z3",

    async solve(input: SolverInput): Promise<SolverResult> {
      if (disposed) {
        return { status: "error", error: "Solver has been disposed" };
      }

      if (input.type !== "z3") {
        return { status: "error", error: "Expected z3 input type" };
      }

      const smtlib = prepareSmtlib(input.smtlib);
      if (!smtlib) {
        return { status: "sat", model: {} };
      }

      return runExclusive(() => solveUnlessFatal(z3.Z3, smtlib));
    },

    dispose() {
      disposed = true;
    },
  };
}
