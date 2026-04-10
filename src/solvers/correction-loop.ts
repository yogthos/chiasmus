/**
 * Correction loop for solver specs — wraps repl-sandbox's generic
 * correctionLoop with chiasmus-specific SolverSession lifecycle.
 */

import { correctionLoop as genericCorrectionLoop } from "repl-sandbox";
import type {
  CorrectionResult as GenericCorrectionResult,
  CorrectionAttempt as GenericCorrectionAttempt,
} from "repl-sandbox";
import type { SolverInput, SolverResult } from "./types.js";
import { SolverSession } from "./session.js";

/** A function that takes a broken spec + error and returns a patched spec */
export type SpecFixer = (
  attempt: SolverInput,
  error: string,
  round: number,
  result?: SolverResult,
) => Promise<SolverInput | null>;

/** Record of a single correction attempt */
export type CorrectionAttempt = GenericCorrectionAttempt<SolverInput, SolverResult>;

/** Result of the full correction loop */
export type CorrectionResult = GenericCorrectionResult<SolverInput, SolverResult>;

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
  const solverType = initialInput.type === "z3" ? "z3" as const : "prolog" as const;
  const session = await SolverSession.create(solverType);
  try {
    return await genericCorrectionLoop<SolverInput, SolverResult>(
      initialInput,
      async (input) => session.solve(input),
      (result) => (result.status === "error" ? result.error : null),
      fixer,
      options,
    );
  } finally {
    session.dispose();
  }
}
