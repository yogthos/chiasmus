import type { SolverInput, SolverResult } from "./types.js";
import { SolverSession } from "./session.js";

const DEFAULT_MAX_ROUNDS = 5;

/** A function that takes a broken spec + error and returns a patched spec */
export type SpecFixer = (
  attempt: SolverInput,
  error: string,
  round: number,
  result?: SolverResult,
) => Promise<SolverInput | null>;

/** Record of a single correction attempt */
export interface CorrectionAttempt {
  round: number;
  input: SolverInput;
  result: SolverResult;
}

/** Result of the full correction loop */
export interface CorrectionResult {
  /** Final solver result (may be success or the last error) */
  result: SolverResult;
  /** Whether the loop converged to a valid result */
  converged: boolean;
  /** Number of rounds taken */
  rounds: number;
  /** Full history of attempts */
  history: CorrectionAttempt[];
}

export interface CorrectionLoopOptions {
  maxRounds?: number;
}

/**
 * Run a bounded correction loop: submit spec to solver, if it errors
 * call the fixer to patch it, resubmit, repeat up to maxRounds.
 *
 * The loop stops when:
 * - The solver returns a non-error result (sat/unsat/unknown/success) → converged
 * - The fixer returns null (gives up) → not converged
 * - Max rounds reached → not converged
 */
export async function correctionLoop(
  initialInput: SolverInput,
  fixer: SpecFixer,
  options: CorrectionLoopOptions = {},
): Promise<CorrectionResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const history: CorrectionAttempt[] = [];

  let currentInput = initialInput;

  for (let round = 1; round <= maxRounds; round++) {
    const solverType = currentInput.type === "z3" ? "z3" as const : "prolog" as const;
    const session = await SolverSession.create(solverType);

    let result: SolverResult;
    try {
      result = await session.solve(currentInput);
    } finally {
      session.dispose();
    }

    history.push({ round, input: currentInput, result });

    // Non-error results mean the solver accepted the spec
    if (result.status !== "error") {
      return { result, converged: true, rounds: round, history };
    }

    // Last round — don't try to fix, just return
    if (round === maxRounds) {
      return { result, converged: false, rounds: round, history };
    }

    // Ask fixer to patch the spec
    const patched = await fixer(currentInput, result.error, round, result);
    if (patched === null) {
      // Fixer gave up
      return { result, converged: false, rounds: round, history };
    }

    currentInput = patched;
  }

  // Should not reach here, but satisfy TypeScript
  const lastAttempt = history[history.length - 1];
  return {
    result: lastAttempt.result,
    converged: false,
    rounds: history.length,
    history,
  };
}
