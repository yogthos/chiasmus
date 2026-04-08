import type { SkillTemplate, SlotDef, Normalization } from "./types.js";
import type { SkillLibrary } from "./library.js";
import type { SolverType } from "../solvers/types.js";
import { SolverSession } from "../solvers/session.js";

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

/** Validate and add a template to the library. Optionally test the example. */
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
    tips: input.tips,
    example: input.example,
  };

  // Optional: test the example through the solver
  let tested = false;
  let testResult: string | undefined;

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
      } finally {
        session.dispose();
      }
    } catch (e: unknown) {
      testResult = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const added = library.addLearned(template);
  if (!added) {
    return { created: false, errors: [`Failed to add template "${input.name}" to library`] };
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
  const lines = example.split("\n");
  let program = example;
  let query = "true.";

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("?-")) {
      query = trimmed.replace(/^\?\-\s*/, "");
      program = lines.slice(0, i).join("\n").trim();
      break;
    }
  }

  return { type: "prolog" as const, program, query };
}
