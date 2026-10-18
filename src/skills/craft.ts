import type { SkillTemplate, SlotDef, Normalization } from "./types.js";
import type { SkillLibrary } from "./library.js";
import type { SolverType } from "../solvers/types.js";
import { SolverSession } from "../solvers/session.js";
import { extractPrologQuery } from "../formalize/prolog-input.js";

export interface CraftInput {
  name: string;
  domain: string;
  solver: string;
  signature: string;
  skeleton: string;
  slots: Array<{ name: string; description: string; format: string }>;
  normalizations: Array<{ source: string; transform: string }>;
  tips?: string[];
  example?: string;
  test?: boolean;
}

export interface CraftResult {
  created: boolean;
  template?: string;
  domain?: string;
  solver?: string;
  slots?: number;
  tested?: boolean;
  testResult?: string;
  errors?: string[];
}

/** Validate a template definition, returning an array of error strings (empty = valid) */
export function validateTemplate(input: CraftInput, library: SkillLibrary): string[] {
  const errors: string[] = [];

  // Required string fields
  for (const field of ["name", "domain", "solver", "signature", "skeleton"] as const) {
    if (typeof input[field] !== "string" || !input[field]) {
      errors.push(`'${field}' is required and must be a non-empty string`);
    }
  }

  // Solver type
  if (input.solver !== "z3" && input.solver !== "prolog") {
    errors.push(`'solver' must be "z3" or "prolog", got "${input.solver}"`);
  }

  // Name format and uniqueness
  if (typeof input.name === "string" && input.name) {
    if (!/^[a-z][a-z0-9-]*$/.test(input.name)) {
      errors.push(`'name' must be kebab-case (lowercase letters, digits, hyphens)`);
    }
    if (library.get(input.name)) {
      errors.push(`Template "${input.name}" already exists in library`);
    }
  }

  // Slots array
  if (!Array.isArray(input.slots) || input.slots.length === 0) {
    errors.push("'slots' must be a non-empty array");
  } else {
    for (let i = 0; i < input.slots.length; i++) {
      const s = input.slots[i];
      if (!s.name || !s.description || !s.format) {
        errors.push(`slots[${i}] must have non-empty 'name', 'description', and 'format'`);
      }
    }
  }

  // Normalizations array
  if (!Array.isArray(input.normalizations) || input.normalizations.length === 0) {
    errors.push("'normalizations' must be a non-empty array");
  } else {
    for (let i = 0; i < input.normalizations.length; i++) {
      const n = input.normalizations[i];
      if (!n.source || !n.transform) {
        errors.push(`normalizations[${i}] must have non-empty 'source' and 'transform'`);
      }
    }
  }

  // Optional fields. The library binds `example` to a TEXT column and
  // stores `tips` as JSON that formalize later maps over as strings, so any
  // other shape is refused here instead of failing at the insert or at use.
  // null counts as absent: JSON callers send it for an omitted field.
  if (input.example != null && typeof input.example !== "string") {
    errors.push("'example' must be a string when given");
  }
  if (
    input.tips != null &&
    !(Array.isArray(input.tips) && input.tips.every((t) => typeof t === "string"))
  ) {
    errors.push("'tips' must be an array of strings when given");
  }

  // Cross-validate skeleton slots vs slot definitions
  if (typeof input.skeleton === "string" && Array.isArray(input.slots)) {
    const skeletonSlots = new Set(
      [...input.skeleton.matchAll(/\{\{SLOT:(\w+)\}\}/g)].map((m) => m[1]),
    );
    const definedSlots = new Set(input.slots.map((s) => s.name));

    for (const name of skeletonSlots) {
      if (!definedSlots.has(name)) {
        errors.push(`Slot '${name}' referenced in skeleton but not defined in slots array`);
      }
    }
    for (const name of definedSlots) {
      if (!skeletonSlots.has(name)) {
        errors.push(`Slot '${name}' defined in slots array but not referenced in skeleton`);
      }
    }
  }

  return errors;
}

/** Validate and add a template to the library. Optionally test the example first; a solver error for it adds nothing. */
export async function craftTemplate(
  input: CraftInput,
  library: SkillLibrary,
): Promise<CraftResult> {
  const errors = validateTemplate(input, library);
  if (errors.length > 0) {
    return { created: false, errors };
  }

  const template: SkillTemplate = {
    name: input.name,
    domain: input.domain,
    solver: input.solver as SolverType,
    signature: input.signature,
    skeleton: input.skeleton,
    slots: input.slots as SlotDef[],
    normalizations: input.normalizations as Normalization[],
    // validateTemplate lets null through as absent, and the library stores
    // an absent field as NULL and loads it back as undefined. Fold null here
    // so this instance serves what a reopened library does.
    tips: input.tips ?? undefined,
    example: input.example ?? undefined,
  };

  // Optional: test the example through the solver
  let tested = false;
  let testResult: string | undefined;
  let testError: string | undefined;

  if (input.test && input.example) {
    tested = true;
    try {
      const session = await SolverSession.create(template.solver);
      try {
        const solverInput = template.solver === "z3"
          ? { type: "z3" as const, smtlib: input.example }
          : buildPrologInput(input.example);
        const result = await session.solve(solverInput);
        testResult = result.status;
        if (result.status === "error") testError = result.error.trim();
      } finally {
        session.dispose();
      }
    } catch (e: unknown) {
      testError = e instanceof Error ? e.message : String(e);
      testResult = `error: ${testError}`;
    }
  }

  // No tool removes a stored template, so one whose example the solver could
  // not run is refused rather than stored unchecked. unsat, unknown and a
  // Prolog query without answers are stored: an example may show that case.
  if (testError !== undefined) {
    return {
      created: false,
      tested,
      testResult,
      errors: [`Example test failed, so the template was not stored: ${testError}`],
    };
  }

  const added = library.addTemplate(template);
  if (!added) {
    // addTemplate answers false for a taken name wherever the name is held,
    // and validation above leaves a taken name as its only reason to refuse.
    // A name this instance holds was added here after validation, while the
    // example was being tested. One it does not hold is on disk only.
    const reason = library.get(input.name)
      ? `Template "${input.name}" already exists in library`
      : `Template name "${input.name}" is already taken on disk: another process sharing this library's directory stored it, and this instance sees it after a restart`;
    return { created: false, errors: [reason] };
  }

  return {
    created: true,
    template: input.name,
    domain: input.domain,
    solver: input.solver,
    slots: input.slots.length,
    tested,
    testResult,
  };
}

function buildPrologInput(example: string) {
  const { program, query } = extractPrologQuery(example);
  return { type: "prolog" as const, program, query };
}
