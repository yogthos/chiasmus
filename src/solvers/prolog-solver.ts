import pl from "tau-prolog";
import type { Solver, SolverInput, SolverResult, PrologAnswer } from "./types.js";

const MAX_ANSWERS = 1000;
const MAX_INFERENCES = 100_000;

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

      const session = pl.create(MAX_INFERENCES);

      try {
        await consult(session, input.program);
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

      return { status: "success", answers };
    },

    dispose() {
      if (!disposed) {
        disposed = true;
      }
    },
  };
}
