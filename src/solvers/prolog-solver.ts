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
  const parts: string[] = [":- dynamic(trace_goal/1).\n\n"];

  let pos = 0;
  const len = program.length;

  while (pos < len) {
    // Skip whitespace in bulk
    const wsStart = pos;
    while (pos < len && /\s/.test(program[pos])) pos++;
    if (pos > wsStart) {
      parts.push(program.slice(wsStart, pos));
    }
    if (pos >= len) break;

    // Skip line comments in bulk
    if (program[pos] === "%") {
      const nlIdx = program.indexOf("\n", pos);
      if (nlIdx === -1) { parts.push(program.slice(pos)); break; }
      parts.push(program.slice(pos, nlIdx + 1));
      pos = nlIdx + 1;
      continue;
    }

    // Scan a clause: from pos to the next period at depth 0
    const clauseStart = pos;
    let depth = 0;
    let inQuote = false;

    while (pos < len) {
      const ch = program[pos];

      if (inQuote) {
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
        pos++;
        const clause = program.slice(clauseStart, pos).trim();

        if (clause.startsWith(":-")) {
          parts.push(clause + "\n");
          break;
        }

        const neckIdx = findNeck(clause);
        if (neckIdx >= 0) {
          const head = clause.slice(0, neckIdx).trim();
          const body = clause.slice(neckIdx + 2).slice(0, -1).trim();
          parts.push(`${head} :- ${body}, assertz(trace_goal(${head})).\n`);
        } else {
          parts.push(clause + "\n");
        }
        break;
      }

      pos++;
    }

    if (pos >= len && program.slice(clauseStart, pos).trim()) {
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
