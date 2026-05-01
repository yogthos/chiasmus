import { initProlog, type PrologFull } from "prolog-wasm-full";
import type { Solver, SolverInput, SolverResult, PrologAnswer } from "./types.js";

const MAX_ANSWERS = 1000;
const DEFAULT_MAX_INFERENCES = 100_000;
const MAX_TRACE_ENTRIES = 500;

// Internal variable for detecting inference-limit overrun. Picked to be
// unlikely to collide with anything a user program writes.
const LIMIT_MARKER_VAR = "ChiasmusLimitResult_3F2A1B";
const LIMIT_EXCEEDED_ATOM = "inference_limit_exceeded";

const SAFE_PATH_RE = /^[/A-Za-z0-9_.-]+$/;

// prolog-wasm-full has a single-init lifecycle (Emscripten factory
// invalidates after first instantiation), so we lazily init exactly
// one global instance shared across solver calls. Per-solve isolation
// happens by wrapping every consult in its own SWI module and tearing
// the module down afterwards — concurrent solves with overlapping
// predicate names see independent namespaces. The `/tmp/_chiasmus_*.pl`
// paths look like host filesystem paths but live in Emscripten's
// in-memory MEMFS — nothing touches the host disk.
let plPromise: Promise<PrologFull> | null = null;
let pathCounter = 0;
let sessionCounter = 0;

function uniqueSessionModule(): string {
  return `chiasmus_session_${++sessionCounter}`;
}

async function getPl(): Promise<PrologFull> {
  plPromise ??= (async () => {
    const pl = await initProlog();
    // The message-capture predicate and hook must be module-qualified to
    // `user:`. SWI invokes message_hook from whichever module is emitting
    // the message (often `system:` for low-level errors), and an unqualified
    // assertz inside the hook body would resolve to the caller's module —
    // failing silently with `Unknown procedure: system:$chiasmus_msg/2` and
    // dropping the error on the floor.
    pl.consult(`
      :- use_module(library(lists)).
      :- use_module(library(clpfd)).
      :- dynamic(user:'$chiasmus_msg'/2).
      :- multifile(user:message_hook/3).
      user:message_hook(_Term, Kind, Lines) :-
          (Kind == error ; Kind == warning),
          with_output_to(string(S),
              print_message_lines(current_output, '', Lines)),
          assertz(user:'$chiasmus_msg'(Kind, S)),
          fail.
    `);
    return pl;
  })();
  return plPromise;
}

function clearMessages(pl: PrologFull): void {
  try {
    pl.stock.call(`retractall(user:'$chiasmus_msg'(_, _))`);
  } catch {
    /* best-effort */
  }
}

function collectErrorMessages(pl: PrologFull): string[] {
  try {
    const rows = pl.query(`user:'$chiasmus_msg'(error, M)`).all();
    return rows
      .map((r) => (r.M == null ? "" : String(r.M).trim()))
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Validate a query string by attempting to parse it. Returns null on
 * success, or the syntax-error description on failure.
 *
 * `pl.query()` does not propagate parse errors through the JS layer
 * (they print to stderr but the handle just returns no answers). We
 * pre-parse via `read_term_from_atom/3` so callers see a structured
 * error rather than silent empty results.
 */
function validateQuery(pl: PrologFull, goal: string): string | null {
  // Single-quote escape for embedding in Prolog atom syntax.
  const atom = goal.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  clearMessages(pl);
  const ok = pl.stock.call(
    `catch(read_term_from_atom('${atom}', _, []), Err, ` +
      `(with_output_to(string(EStr), write(Err)), ` +
      `assertz(user:'$chiasmus_msg'(error, EStr))))`,
  );
  const errs = collectErrorMessages(pl);
  if (errs.length > 0) return errs.join("\n");
  if (!ok) return "query parse failed";
  return null;
}

function uniqueTempPath(): string {
  return `/tmp/_chiasmus_prolog_${Date.now()}_${pathCounter++}.pl`;
}

// ---------------------------------------------------------------------
// Term rendering — reverse of prolog-wasm-full's stock marshaller.
//
// The stock query API returns these JS shapes:
//   atom              → string  ("knight")
//   integer / float   → number
//   true / false      → boolean
//   list              → array
//   compound foo(...) → { $t: "t", functor: "foo", foo: [[arg1, ...]] }
// Args are double-wrapped (`foo: [[a, b, c]]`) — outer array has one
// element, the args tuple. We unwrap and render to Prolog syntax.

function isAtomBare(s: string): boolean {
  return /^[a-z][a-zA-Z0-9_]*$/.test(s);
}

function termToProlog(value: unknown): string {
  if (value === null || value === undefined) return "_";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (isAtomBare(value)) return value;
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(termToProlog).join(", ")}]`;
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.$t === "t" && typeof v.functor === "string") {
      const fn = v.functor;
      const argsWrap = v[fn];
      const args: unknown[] =
        Array.isArray(argsWrap) &&
        argsWrap.length === 1 &&
        Array.isArray(argsWrap[0])
          ? (argsWrap[0] as unknown[])
          : Array.isArray(argsWrap)
            ? (argsWrap as unknown[])
            : [argsWrap];
      if (fn === "-" && args.length === 2) {
        return `${termToProlog(args[0])}-${termToProlog(args[1])}`;
      }
      return `${fn}(${args.map(termToProlog).join(", ")})`;
    }
    return JSON.stringify(v);
  }
  return JSON.stringify(value);
}

function bindingsToFormatted(bindings: Record<string, string>): string {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return "true";
  return entries.map(([k, v]) => `${k} = ${v}`).join(", ");
}

/**
 * Strip a trailing `.` or leading `?-` the user/model sometimes includes
 * around a goal — SWI's stock query API expects a bare goal expression.
 */
function normalizeQuery(q: string): string {
  let s = q.trim();
  if (s.startsWith("?-")) s = s.slice(2).trim();
  if (s.endsWith(".")) s = s.slice(0, -1).trim();
  return s;
}

class CapReachedError extends Error {}
class LimitExceededError extends Error {}

interface QueryOpts {
  /** When set, bail with limit error if marker var binds to LIMIT_EXCEEDED_ATOM. */
  detectLimitMarker?: boolean;
  /** Cap on returned answers. */
  maxAnswers?: number;
}

function runQuery(
  pl: PrologFull,
  goal: string,
  opts: QueryOpts = {},
): { answers: Record<string, string>[] } | { error: string } {
  const normalized = normalizeQuery(goal);
  if (!normalized) return { error: "empty query" };

  let handle: ReturnType<PrologFull["query"]>;
  try {
    handle = pl.query(normalized);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const answers: Record<string, string>[] = [];
  const cap = opts.maxAnswers ?? MAX_ANSWERS;
  let limitExceeded = false;

  try {
    try {
      handle.forEach((rawBindings) => {
        if (answers.length >= cap) throw new CapReachedError();

        if (opts.detectLimitMarker) {
          const marker = rawBindings[LIMIT_MARKER_VAR];
          if (marker === LIMIT_EXCEEDED_ATOM) {
            limitExceeded = true;
            throw new LimitExceededError();
          }
        }

        const bindings: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawBindings)) {
          if (k === LIMIT_MARKER_VAR) continue;
          bindings[k] = termToProlog(v);
        }
        answers.push(bindings);
      });
    } finally {
      try {
        handle.close();
      } catch {
        /* best-effort */
      }
    }
  } catch (e) {
    if (e instanceof LimitExceededError || limitExceeded) {
      return { error: "inference limit exceeded" };
    }
    if (!(e instanceof CapReachedError)) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    // Cap reached — return what we have.
  }

  return { answers };
}

/**
 * Tear down a session module: abolish every locally-defined predicate
 * (skipping imports), unload the source file, unlink the MEMFS path.
 * Returns warnings — strings naming each step that failed. Cleanup is
 * best-effort: a failure leaks a small amount of state into the global
 * SWI namespace but the user already has their answer, so we surface
 * it on the result rather than masking the solve outcome.
 */
function cleanupSession(
  pl: PrologFull,
  moduleId: string,
  path: string,
): string[] {
  const warnings: string[] = [];

  // Enumerate user-defined predicates in the module. `imported_from(_)`
  // filter excludes preds pulled in by `use_module(library(...))` — we
  // don't want to abolish library bindings, only the user's clauses.
  let preds: Record<string, unknown>[] = [];
  try {
    preds = pl
      .query(
        `current_predicate(${moduleId}:F/A), ` +
          `functor(H, F, A), ` +
          `\\+ predicate_property(${moduleId}:H, imported_from(_))`,
      )
      .all();
  } catch (e) {
    warnings.push(
      `enumerate predicates in ${moduleId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  for (const row of preds) {
    const f = row.F;
    const a = row.A;
    if (typeof f !== "string" || typeof a !== "number") {
      warnings.push(`skip non-canonical predicate spec: ${String(f)}/${String(a)}`);
      continue;
    }
    if (!isAtomBare(f)) {
      // Quoted atoms (e.g. internal `$...` preds) — abolish via quoted form.
      try {
        const quoted = `'${f.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
        const ok = pl.stock.call(`abolish(${moduleId}:${quoted}/${a})`);
        if (!ok) warnings.push(`abolish ${moduleId}:${quoted}/${a} returned false`);
      } catch (e) {
        warnings.push(
          `abolish ${moduleId}:${f}/${a}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    }
    try {
      const ok = pl.stock.call(`abolish(${moduleId}:${f}/${a})`);
      if (!ok) warnings.push(`abolish ${moduleId}:${f}/${a} returned false`);
    } catch (e) {
      warnings.push(
        `abolish ${moduleId}:${f}/${a}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  try {
    pl.stock.call(`unload_file('${path}')`);
  } catch (e) {
    warnings.push(
      `unload_file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    pl.em.FS.unlink(path);
  } catch {
    // File may already be gone (e.g. consult never ran). Not a warning —
    // we explicitly call cleanupSession even on the never-consulted path.
  }

  return warnings;
}

/**
 * Best-effort unlink for the case where the program never made it to
 * consult. Failures here are silent — there's nothing actionable for
 * the caller (the file simply may not exist).
 */
function tryUnlink(pl: PrologFull, path: string): string[] {
  try {
    pl.em.FS.unlink(path);
  } catch {
    /* never written */
  }
  return [];
}

// ---------------------------------------------------------------------
// Tracing instrumentation
// ---------------------------------------------------------------------
//
// Rewrites each rule `head :- body.` to `head :- body, assertz(trace_goal(head)).`
// so trace_goal/1 accumulates which rules fired with bound variables.
// Facts and directives are left unchanged.

function instrumentForTracing(program: string): string {
  const parts: string[] = [":- dynamic(trace_goal/1).\n\n"];

  let pos = 0;
  const len = program.length;

  while (pos < len) {
    const wsStart = pos;
    while (pos < len && /\s/.test(program[pos])) pos++;
    if (pos > wsStart) {
      parts.push(program.slice(wsStart, pos));
    }
    if (pos >= len) break;

    if (program[pos] === "%") {
      const nlIdx = program.indexOf("\n", pos);
      if (nlIdx === -1) { parts.push(program.slice(pos)); break; }
      parts.push(program.slice(pos, nlIdx + 1));
      pos = nlIdx + 1;
      continue;
    }

    const clauseStart = pos;
    let depth = 0;
    let inQuote = false;
    let emittedClause = false;

    while (pos < len) {
      const ch = program[pos];

      if (inQuote) {
        if (ch === "\\") {
          pos += 2;
          continue;
        }
        if (ch === "'") {
          if (pos + 1 < len && program[pos + 1] === "'") { pos += 2; continue; }
          inQuote = false;
        }
        pos++;
        continue;
      }

      if (ch === "'") { inQuote = true; pos++; continue; }
      if (ch === "%") {
        const nlIdx = program.indexOf("\n", pos);
        if (nlIdx === -1) { pos = len; break; }
        pos = nlIdx + 1;
        continue;
      }
      if (ch === "(") { depth++; pos++; continue; }
      if (ch === ")") { depth--; pos++; continue; }

      if (ch === "." && depth === 0) {
        // A `.` flanked by digits is a decimal literal, not a clause
        // terminator. In Prolog only whitespace, EOF, or `%` legitimately
        // follows a clause-ending period, so the digit-flanked case is
        // unambiguous.
        const prevCh = pos > 0 ? program[pos - 1] : "";
        const nextCh = pos + 1 < len ? program[pos + 1] : "";
        if (prevCh >= "0" && prevCh <= "9" && nextCh >= "0" && nextCh <= "9") {
          pos++;
          continue;
        }
        pos++;
        const clause = program.slice(clauseStart, pos).trim();

        if (clause.startsWith(":-")) {
          parts.push(clause + "\n");
        } else {
          const neckIdx = findNeck(clause);
          if (neckIdx >= 0) {
            const head = clause.slice(0, neckIdx).trim();
            const body = clause.slice(neckIdx + 2).slice(0, -1).trim();
            parts.push(`${head} :- ${body}, assertz(trace_goal(${head})).\n`);
          } else {
            parts.push(clause + "\n");
          }
        }
        emittedClause = true;
        break;
      }

      pos++;
    }

    // If we exhausted the input without finding a clause-terminator, the
    // tail is a partial clause — push it verbatim so SWI surfaces the
    // syntax error rather than us silently dropping it. Don't push if we
    // already emitted a clause from the inner while: pos can equal len
    // there too (final clause flush against EOF) and we'd double-emit.
    if (!emittedClause && program.slice(clauseStart, pos).trim()) {
      parts.push(program.slice(clauseStart));
    }
  }

  return parts.join("").trim();
}

function findNeck(clause: string): number {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < clause.length - 1; i++) {
    const ch = clause[i];
    if (inQuote) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'" && clause[i + 1] === "'") { i++; continue; }
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") { inQuote = true; continue; }
    if (ch === "%") {
      const nl = clause.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === ":" && clause[i + 1] === "-" && depth === 0) {
      return i;
    }
  }
  return -1;
}

export function createPrologSolver(): Solver {
  let disposed = false;

  return {
    type: "prolog",

    async solve(input: SolverInput): Promise<SolverResult> {
      if (disposed) {
        return { status: "error", error: "Solver has been disposed" };
      }
      if (input.type !== "prolog") {
        return { status: "error", error: "Expected prolog input type" };
      }

      let pl: PrologFull;
      try {
        pl = await getPl();
      } catch (e) {
        return {
          status: "error",
          error: `prolog init failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      const explain = input.explain ?? false;
      const userProgram = explain
        ? instrumentForTracing(input.program)
        : input.program;
      const inferenceBudget = input.maxInferences ?? DEFAULT_MAX_INFERENCES;

      const moduleId = uniqueSessionModule();
      const path = uniqueTempPath();
      if (!SAFE_PATH_RE.test(path)) {
        return {
          status: "error",
          error: `internal: tempfile path failed safety check: ${path}`,
        };
      }

      // Wrap the user code in a fresh module. `:- module(M, [])` puts
      // every definition in M's namespace; built-ins still resolve via
      // the auto-imported `system` module, and we explicitly import
      // the libraries the user is likely to reach for. This is what
      // gives concurrent solves with overlapping predicate names
      // independent state.
      const program =
        `:- module(${moduleId}, []).\n` +
        `:- use_module(library(lists)).\n` +
        `:- use_module(library(clpfd)).\n` +
        userProgram;

      let consulted = false;

      const finalize = (
        result: SolverResult,
        prefix: string[] = [],
      ): SolverResult => {
        const cleanupWarnings = consulted
          ? cleanupSession(pl, moduleId, path)
          : tryUnlink(pl, path);
        const warnings = [...prefix, ...cleanupWarnings];
        if (warnings.length === 0) return result;
        if (result.status === "success") {
          return { ...result, warnings };
        }
        if (result.status === "error") {
          return { ...result, warnings };
        }
        return result;
      };

      try {
        pl.em.FS.writeFile(path, program);
      } catch (e) {
        return finalize({
          status: "error",
          error: `failed to stage program: ${e instanceof Error ? e.message : String(e)}`,
        });
      }

      clearMessages(pl);
      try {
        pl.stock.call(`consult('${path}')`);
        consulted = true;
      } catch (e) {
        return finalize({
          status: "error",
          error: `consult failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      const consultErrs = collectErrorMessages(pl);
      if (consultErrs.length > 0) {
        return finalize({ status: "error", error: consultErrs.join("\n") });
      }

      const normalized = normalizeQuery(input.query);
      if (!normalized) {
        return finalize({ status: "error", error: "empty query" });
      }
      const parseErr = validateQuery(pl, normalized);
      if (parseErr) {
        return finalize({ status: "error", error: parseErr });
      }

      // Wrap the user goal in three concentric layers (innermost first):
      //   1. `${moduleId}:Goal` — resolve predicates against the session
      //      module, so the user's `parent(...)` finds their own clauses.
      //   2. `call_with_inference_limit(..., Budget, Marker)` — bound
      //      runaway labelings; Marker binds to LIMIT_EXCEEDED_ATOM on
      //      overrun.
      //   3. `catch(..., Err, recovery)` — turn existence_error and
      //      friends into structured solver errors instead of letting
      //      SWI print them and the JS handle silently return zero
      //      answers. Recovery asserts the error term to our shared
      //      message buffer and fails so the iterator terminates.
      const wrapped =
        `catch(` +
        `call_with_inference_limit((${moduleId}:(${normalized})), ${inferenceBudget}, ${LIMIT_MARKER_VAR}), ` +
        `Err, ` +
        `(with_output_to(string(EStr), write(Err)), ` +
        `assertz(user:'$chiasmus_msg'(error, EStr)), fail))`;

      clearMessages(pl);
      const queryResult = runQuery(pl, wrapped, { detectLimitMarker: true });
      const queryErrs = collectErrorMessages(pl);
      if (queryErrs.length > 0) {
        return finalize({ status: "error", error: queryErrs.join("\n") });
      }
      if ("error" in queryResult) {
        return finalize({ status: "error", error: queryResult.error });
      }

      const answers: PrologAnswer[] = queryResult.answers.map((bindings) => ({
        bindings,
        formatted: bindingsToFormatted(bindings),
      }));

      if (!explain) {
        return finalize({ status: "success", answers });
      }

      // Collect derivation trace from the session-local trace_goal/1.
      const traceResult = runQuery(pl, `${moduleId}:trace_goal(X)`, {
        maxAnswers: MAX_TRACE_ENTRIES,
      });
      if ("error" in traceResult) {
        return finalize({ status: "success", answers });
      }
      const trace: string[] = [];
      const seen = new Set<string>();
      for (const row of traceResult.answers) {
        const entry = row.X;
        if (typeof entry === "string" && !seen.has(entry)) {
          seen.add(entry);
          trace.push(entry);
        }
      }
      return finalize({ status: "success", answers, trace });
    },

    dispose() {
      if (!disposed) {
        disposed = true;
      }
    },
  };
}
