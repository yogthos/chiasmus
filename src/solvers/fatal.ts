import type { SolverType } from "./types.js";

/**
 * A solver's WASM module is unusable after an Emscripten abort or a trap such
 * as "memory access out of bounds": its heap and locks stay as they were
 * mid-call, and the next call into it can block the event loop for good. The
 * process then stays alive but stops responding, even to SIGTERM, whose
 * handler needs the event loop. Solvers report such a failure here and refuse
 * further work; the CLI entry registers a handler that exits, so the process
 * can be restarted.
 */
export type FatalSolverErrorHandler = (solver: SolverType, error: Error) => void;

let handler: FatalSolverErrorHandler | null = null;

export function setFatalSolverErrorHandler(next: FatalSolverErrorHandler | null): void {
  handler = next;
}

export function reportFatalSolverError(solver: SolverType, error: Error): void {
  handler?.(solver, error);
}

// The tsconfig lib has no WebAssembly types; Node always has the global.
const WasmRuntimeError = (
  globalThis as unknown as { WebAssembly: { RuntimeError: ErrorConstructor } }
).WebAssembly.RuntimeError;

/**
 * True for an Emscripten abort or a WASM trap: both throw a
 * WebAssembly.RuntimeError. The message is never consulted, because solver
 * errors quote user input — a function named `|Aborted(|` is not a crash.
 */
export function isFatalWasmError(e: unknown): boolean {
  return e instanceof WasmRuntimeError;
}

/** The error a module's onAbort hook records: what Emscripten's abort() throws. */
export function abortError(what: unknown): Error {
  return new WasmRuntimeError(`Aborted(${String(what)})`);
}

/** Keeps a catch block from turning a fatal WASM error into a solver result. */
export function rethrowIfFatal(e: unknown): void {
  if (isFatalWasmError(e)) throw e;
}

/**
 * Entry-point policy: log to stderr and exit 1 right away, so the client or
 * supervisor that started the process sees it fail and can start a fresh one.
 */
export function exitOnFatalSolverError(
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  setFatalSolverErrorHandler((solver, error) => {
    console.error(
      `[Chiasmus] fatal ${solver} WASM error, exiting so the process is restarted: ${error.message}`,
    );
    exit(1);
  });
}
