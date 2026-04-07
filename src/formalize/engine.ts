import type { LLMAdapter } from "../llm/types.js";
import type { SkillLibrary } from "../skills/library.js";
import type { SkillTemplate } from "../skills/types.js";
import type { SolverInput, SolverResult, PrologAnswer } from "../solvers/types.js";
import { correctionLoop } from "../solvers/correction-loop.js";
import type { CorrectionAttempt } from "../solvers/correction-loop.js";
import { lintSpec } from "./validate.js";

/** Result of formalize() — template + instructions for the calling LLM */
export interface FormalizeResult {
  template: SkillTemplate;
  instructions: string;
}

/** Result of solve() — includes solver result + correction history */
export interface SolveResult {
  result: SolverResult;
  converged: boolean;
  rounds: number;
  history: CorrectionAttempt[];
  templateUsed: string | null;
  /** Convenience: extracted answers for Prolog results */
  answers: PrologAnswer[];
}

const FORMALIZE_SYSTEM = `You are a formalization engine that translates natural language problems into formal logic specifications.

Your job:
1. Read the problem description
2. Read the template skeleton and slot descriptions
3. Use the template as a STARTING POINT — fill the slots, but also adapt the structure if the problem requires it
4. You may add extra variables, assertions, or rules beyond what the template defines
5. You may remove or restructure parts of the skeleton that don't fit the specific problem
6. Return ONLY the complete specification — no explanation, no markdown fences, no comments outside the spec

The template is guidance, not a constraint. The goal is a correct specification for the problem, not a rigid fill-in-the-blanks.

For Z3 (SMT-LIB): output valid SMT-LIB assertions. Do NOT include (check-sat) or (get-model).
For Prolog: output valid ISO Prolog facts and rules.

Be precise with syntax. The specification will be fed directly to a solver.`;

const FIX_SYSTEM = `You are a formal logic repair engine. You receive a specification that failed verification and the error message from the solver.

Fix the specification to resolve the error. Return ONLY the corrected specification — no explanation, no markdown fences.

Common issues:
- Type mismatches: ensure all comparisons use matching types
- Missing declarations: every constant must be declared before use
- Syntax errors: check parentheses, commas, periods
- For Prolog: ensure all clauses end with a period`;

export class FormalizationEngine {
  constructor(
    private library: SkillLibrary,
    private llm: LLMAdapter,
  ) {}

  /**
   * Formalize a problem: select a template and return it with
   * fill instructions. Does NOT execute or call the LLM for filling.
   */
  async formalize(problem: string): Promise<FormalizeResult> {
    const results = this.library.search(problem, { limit: 1 });
    const template = results.length > 0
      ? results[0].template
      : this.library.list()[0].template; // fallback to first template

    const instructions = this.buildInstructions(problem, template);
    return { template, instructions };
  }

  /**
   * End-to-end solve: select template, ask LLM to fill slots,
   * submit to solver with correction loop.
   */
  async solve(problem: string, maxRounds = 5): Promise<SolveResult> {
    const { template } = await this.formalize(problem);

    // Ask LLM to fill the template
    let filledSpec = await this.llmFill(problem, template);

    // Lint loop: auto-fix what we can, ask LLM to fix the rest
    filledSpec = await this.lintLoop(filledSpec, template, maxRounds);

    // Build solver input
    const initialInput = this.buildSolverInput(template, filledSpec);

    // Run correction loop with LLM as fixer
    const correctionResult = await correctionLoop(
      initialInput,
      async (attempt, error) => {
        const fixed = await this.llmFix(attempt, error, template);
        // Lint the fix before resubmitting to the solver
        const linted = await this.lintLoop(fixed, template, 2);
        return this.buildSolverInput(template, linted);
      },
      { maxRounds },
    );

    // Record template use
    this.library.recordUse(template.name, correctionResult.converged);

    return {
      result: correctionResult.result,
      converged: correctionResult.converged,
      rounds: correctionResult.rounds,
      history: correctionResult.history,
      templateUsed: template.name,
      answers: correctionResult.result.status === "success"
        ? correctionResult.result.answers
        : [],
    };
  }

  private buildInstructions(problem: string, template: SkillTemplate): string {
    const slotDescs = template.slots
      .map((s) => `  {{SLOT:${s.name}}} — ${s.description}\n    Example: ${s.format}`)
      .join("\n\n");

    // Find matching normalization guidance
    const normGuidance = template.normalizations
      .map((n) => `  - ${n.source}: ${n.transform}`)
      .join("\n");

    const queryNote = template.solver === "prolog"
      ? `\n\nPROLOG QUERY: After filling the template, you will also need to provide a Prolog query goal (ending with a period) that asks the question implied by the problem.`
      : "";

    return `TEMPLATE: ${template.name} (${template.solver})
DESCRIPTION: ${template.signature}

SKELETON:
${template.skeleton}

SLOTS TO FILL:
${slotDescs}

NORMALIZATION GUIDANCE:
${normGuidance}
${queryNote}

PROBLEM: ${problem}

Fill each {{SLOT:name}} in the skeleton with appropriate ${template.solver === "z3" ? "SMT-LIB" : "Prolog"} code.
The template is a STARTING POINT — adapt the structure if the problem requires it.
You may add extra variables, assertions, or rules. You may remove or restructure parts that don't fit.
${template.solver === "z3" ? "Do NOT include (check-sat) or (get-model) — the tool adds these automatically." : "Ensure all clauses end with a period."}
Return only the complete filled specification.`;
  }

  private async llmFill(problem: string, template: SkillTemplate): Promise<string> {
    const instructions = this.buildInstructions(problem, template);

    const response = await this.llm.complete(FORMALIZE_SYSTEM, [
      { role: "user", content: instructions },
    ]);

    return this.cleanResponse(response);
  }

  private async llmFix(
    attempt: SolverInput,
    error: string,
    template: SkillTemplate,
  ): Promise<string> {
    const spec = attempt.type === "z3" ? attempt.smtlib : attempt.program;

    const response = await this.llm.complete(FIX_SYSTEM, [
      {
        role: "user",
        content: `SOLVER: ${template.solver}
SPECIFICATION:
${spec}

ERROR:
${error}

Fix the specification and return only the corrected version.`,
      },
    ]);

    return this.cleanResponse(response);
  }

  private buildSolverInput(template: SkillTemplate, spec: string): SolverInput {
    if (template.solver === "z3") {
      return { type: "z3", smtlib: spec };
    }

    // For Prolog, try to extract query from the spec if it contains ?-
    const queryMatch = spec.match(/\?\-\s*(.+\.)\s*$/m);
    let program = spec;
    let query = "true.";

    if (queryMatch) {
      query = queryMatch[1];
      program = spec.replace(/\?\-\s*.+\.\s*$/m, "").trim();
    }

    return { type: "prolog", program, query };
  }

  /**
   * Lint loop: auto-fix what we can, then ask the LLM to fix remaining errors.
   * Repeats until the spec passes validation or maxAttempts is reached.
   */
  private async lintLoop(
    spec: string,
    template: SkillTemplate,
    maxAttempts: number,
  ): Promise<string> {
    let current = spec;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const lint = lintSpec(current, template.solver);
      current = lint.spec; // apply auto-fixes

      if (lint.errors.length === 0) {
        return current; // clean — ready for solver
      }

      // Ask LLM to fix the remaining errors
      const errorReport = [
        ...lint.fixes.map((f) => `[auto-fixed] ${f}`),
        ...lint.errors.map((e) => `[error] ${e}`),
      ].join("\n");

      current = await this.llmFix(
        this.buildSolverInput(template, current),
        `Lint errors (fix these before solver submission):\n${errorReport}`,
        template,
      );
    }

    return current;
  }

  /** Strip markdown fences and trim whitespace from LLM output */
  private cleanResponse(response: string): string {
    return response
      .replace(/^```(?:smt-lib|smtlib|smt|prolog|pl)?\n?/gm, "")
      .replace(/^```\n?/gm, "")
      .trim();
  }
}
