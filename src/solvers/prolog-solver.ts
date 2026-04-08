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
  const lines = program.split("\n");
  const result: string[] = [":- dynamic(trace_goal/1)."];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, directives
    if (!trimmed || trimmed.startsWith("%") || trimmed.startsWith(":-")) {
      result.push(line);
      continue;
    }

    // Match rules: head :- body.
    const ruleMatch = trimmed.match(/^(.+?)\s*:-\s*(.+)\.\s*$/);
    if (ruleMatch) {
      const [, head, body] = ruleMatch;
      result.push(`${head} :- ${body}, assertz(trace_goal(${head.trim()})).`);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
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
