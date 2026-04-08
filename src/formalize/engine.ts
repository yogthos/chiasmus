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

const FORMALIZE_SYSTEM = `Formalization engine. Translate natural language → formal logic.

Template = starting point. Fill slots, but adapt structure if needed. Add/remove variables, assertions, rules.
Output ONLY complete spec. No explanation, no markdown fences.

Z3: valid SMT-LIB. No (check-sat)/(get-model). Use (= flag (or ...)) not (=> ... flag).
Prolog: valid ISO Prolog. All clauses end with period.

Precise syntax — spec goes directly to solver.`;

const FIX_SYSTEM = `Fix failed formal spec. Return ONLY corrected spec. No explanation, no fences.

Common fixes: type mismatches → matching types | missing declarations → declare before use | unbalanced parens | Prolog missing periods.`;

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
      ? `\nAlso provide Prolog query goal (ending with period) for the question.`
      : "";

    const tipsSection = template.tips?.length
      ? `\n⚠ TIPS:\n${template.tips.map((t) => `  ${t}`).join("\n")}`
      : "";

    const exampleSection = template.example
      ? `\nEXAMPLE (reference only — write your own):\n${template.example}`
      : "";

    return `${template.name} (${template.solver}) — ${template.signature}

SKELETON:
${template.skeleton}

SLOTS:
${slotDescs}

NORMALIZE: ${normGuidance}
${tipsSection}${exampleSection}${queryNote}

PROBLEM: ${problem}

Fill {{SLOT:name}} markers. Template = starting point — adapt if needed. Add/remove parts freely.
${template.solver === "z3" ? "No (check-sat)/(get-model)." : "All clauses end with period."}
Output ONLY filled spec.`;
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

    // For Prolog, extract ?- query from the last line that starts with ?-
    const lines = spec.split("\n");
    let program = spec;
    let query = "true.";

    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("?-")) {
        query = trimmed.replace(/^\?\-\s*/, "");
        program = lines.slice(0, i).join("\n").trim();
        break;
      }
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
    const seenErrors = new Set<string>();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const lint = lintSpec(current, template.solver);
      current = lint.spec; // apply auto-fixes

      if (lint.errors.length === 0) {
        return current; // clean — ready for solver
      }

      // Detect oscillation: if we've seen these exact errors before, bail out
      const errorKey = lint.errors.sort().join("|");
      if (seenErrors.has(errorKey)) {
        return current; // LLM is repeating itself — let the solver try
      }
      seenErrors.add(errorKey);

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
