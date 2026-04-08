import type { SolverResult } from "../solvers/types.js";

/**
 * Classify a SolverResult into a human-readable feedback string
 * for the correction loop. This helps the LLM understand what went
 * wrong and how to fix it.
 */
export function classifyFeedback(result: SolverResult): string {
  switch (result.status) {
    case "error":
      return `Solver error: ${result.error}`;

    case "unsat": {
      // Forward-compatible with Phase 1 unsatCore
      const core = (result as any).unsatCore as string[] | undefined;
      if (core && core.length > 0) {
        return `UNSAT — these assertions conflict:\n${core.map((c) => `  - ${c}`).join("\n")}\nThe specification is over-constrained. Remove or weaken one of the conflicting assertions.`;
      }
      return "UNSAT — the constraints are contradictory. The specification is over-constrained.";
    }

    case "sat": {
      const entries = Object.entries(result.model);
      if (entries.length === 0) {
        return "SAT — the constraints are satisfiable (trivially, no variables).";
      }
      const modelStr = entries.map(([k, v]) => `${k} = ${v}`).join(", ");
      return `SAT — the solver found a satisfying assignment: ${modelStr}. If this was unexpected, the spec may be under-constrained.`;
    }

    case "success": {
      if (result.answers.length === 0) {
        return "No Prolog solutions found. Check if facts and rules cover the query pattern. Verify clause heads match.";
      }
      const ansStr = result.answers
        .slice(0, 5)
        .map((a) => a.formatted)
        .join("; ");
      const suffix = result.answers.length > 5
        ? ` (and ${result.answers.length - 5} more)`
        : "";
      return `Prolog found ${result.answers.length} answer(s): ${ansStr}${suffix}`;
    }

    case "unknown":
      return "Solver returned UNKNOWN — the problem may be too complex or outside the solver's decidable fragment. Try simplifying constraints.";
  }
}
