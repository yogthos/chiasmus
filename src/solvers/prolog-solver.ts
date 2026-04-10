import pl from "tau-prolog";
import type { Solver, SolverInput, SolverResult, PrologAnswer } from "./types.js";

const MAX_ANSWERS = 1000;
const MAX_INFERENCES = 100_000;
const MAX_TRACE_ENTRIES = 500;

// Tau Prolog is callback-based; these wrap it in promises.

function consult(session: ReturnType<typeof pl.create>, program: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.consult(program, {
      success: () => resolve(),
      error: (err) => reject(err),
    });
  });
}

function query(session: ReturnType<typeof pl.create>, goal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.query(goal, {
      success: () => resolve(),
      error: (err) => reject(err),
    });
  });
}

function nextAnswer(session: ReturnType<typeof pl.create>): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    session.answer({
      success: (ans) => resolve(ans as unknown as Record<string, unknown>),
      fail: () => resolve(null),
      error: (err) => reject(err),
      limit: () => reject(new Error("inference limit exceeded")),
    });
  });
}

/**
 * Instrument a Prolog program for derivation tracing.
 * Rewrites each rule `head :- body.` to `head :- body, assertz(trace_goal(head)).`
 * so trace_goal/1 accumulates which rules fired with bound variables.
 * Facts and directives are left unchanged.
 */
function instrumentForTracing(program: string): string {
  const result: string[] = [":- dynamic(trace_goal/1)."];

  let i = 0;
  while (i < program.length) {
    // Skip whitespace
    if (/\s/.test(program[i])) {
      result.push(program[i]);
      i++;
      continue;
    }

    // Skip line comments
    if (program[i] === "%") {
      const end = program.indexOf("\n", i);
      if (end === -1) { result.push(program.slice(i)); break; }
      result.push(program.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    // Collect a clause: from current position to the terminating period,
    // respecting parenthesized terms and quoted atoms.
    const clauseStart = i;
    let depth = 0;
    let inQuote = false;

    while (i < program.length) {
      const ch = program[i];

      if (inQuote) {
        if (ch === "'") {
          if (program[i + 1] === "'") { i += 2; continue; }
          inQuote = false;
        }
        i++;
        continue;
      }

      if (ch === "'") { inQuote = true; i++; continue; }
      if (ch === "%") {
        const end = program.indexOf("\n", i);
        if (end === -1) { i = program.length; break; }
        i = end + 1;
        continue;
      }
      if (ch === "(") { depth++; i++; continue; }
      if (ch === ")") { depth--; i++; continue; }

      if (ch === "." && depth === 0) {
        i++;
        const clause = program.slice(clauseStart, i).trim();

        // Skip directives
        if (clause.startsWith(":-")) {
          result.push(clause + "\n");
          break;
        }

        // Check for rule (has :- at depth 0)
        const neckIdx = findNeck(clause);
        if (neckIdx >= 0) {
          const head = clause.slice(0, neckIdx).trim();
          const body = clause.slice(neckIdx + 2).slice(0, -1).trim(); // remove ":-" and trailing "."
          result.push(`${head} :- ${body}, assertz(trace_goal(${head})).\n`);
        } else {
          // Fact — no instrumentation needed
          result.push(clause + "\n");
        }
        break;
      }

      i++;
    }

    // If we didn't find a period (shouldn't happen with valid Prolog), emit as-is
    if (i >= program.length && program.slice(clauseStart, i).trim()) {
      result.push(program.slice(clauseStart));
    }
  }

  return result.join("").trim();
}

function findNeck(clause: string): number {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < clause.length - 1; i++) {
    const ch = clause[i];
    if (inQuote) {
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

function formatError(session: ReturnType<typeof pl.create>, err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return (session as any).format_answer(err) || String(err);
  } catch {
    return String(err);
  }
}

export function createPrologSolver(): Solver {
  let disposed = false;

  return {
    type: "prolog",

    async solve(input: SolverInput): Promise<SolverResult> {
      if (input.type !== "prolog") {
        return { status: "error", error: "Expected prolog input type" };
      }

      const explain = input.explain ?? false;
      const program = explain ? instrumentForTracing(input.program) : input.program;

      const session = pl.create(MAX_INFERENCES);

      try {
        await consult(session, program);
      } catch (e: unknown) {
        return { status: "error", error: formatError(session, e) };
      }

      try {
        await query(session, input.query);
      } catch (e: unknown) {
        return { status: "error", error: formatError(session, e) };
      }

      const answers: PrologAnswer[] = [];
      try {
        for (let i = 0; i < MAX_ANSWERS; i++) {
          const ans = await nextAnswer(session);
          if (ans === null) break;

          const bindings: Record<string, string> = {};
          const links = (ans as any).links;
          if (links) {
            for (const [name, term] of Object.entries(links)) {
              bindings[name] = (term as any).toString?.()
                ?? (term as any).id
                ?? String(term);
            }
          }

          const formatted = pl.format_answer(ans as any) ?? "";
          answers.push({ bindings, formatted });
        }
      } catch (e: unknown) {
        return { status: "error", error: formatError(session, e) };
      }

      // Collect derivation trace if explain mode is on
      if (explain) {
        try {
          await query(session, "trace_goal(X).");
          const trace: string[] = [];
          const seen = new Set<string>();
          for (let i = 0; i < MAX_TRACE_ENTRIES; i++) {
            const t = await nextAnswer(session);
            if (t === null) break;
            const links = (t as any).links;
            if (links?.X) {
              const entry = (links.X as any).toString?.() ?? String(links.X);
              if (!seen.has(entry)) {
                seen.add(entry);
                trace.push(entry);
              }
            }
          }
          return { status: "success", answers, trace };
        } catch {
          // Trace collection failed — return answers without trace
          return { status: "success", answers };
        }
      }

      return { status: "success", answers };
    },

    dispose() {
      if (!disposed) {
        disposed = true;
      }
    },
  };
}
