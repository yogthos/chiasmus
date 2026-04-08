import { createZ3Solver } from "../../src/solvers/z3-solver.js";

interface ValidationGapResult {
  gaps: Array<{
    field: string;
    description: string;
    example?: Record<string, unknown>;
  }>;
}

export async function solveChiasmus(input: {
  fields: Record<string, { type: string; values?: string[] }>;
  frontend: Record<string, { min?: number; max?: number }>;
  backend: Record<string, { min?: number; max?: number }>;
}): Promise<ValidationGapResult> {
  const solver = await createZ3Solver();
  const gaps: ValidationGapResult["gaps"] = [];

  try {
    for (const [field, frontendRule] of Object.entries(input.frontend)) {
      const backendRule = input.backend[field];
      if (!backendRule) continue;

      // Build SMT-LIB: find a value that passes frontend but fails backend
      const smtlib = buildGapCheck(field, frontendRule, backendRule);
      const result = await solver.solve({ type: "z3", smtlib });

      if (result.status === "sat") {
        const value = parseInt(result.model[field], 10);
        gaps.push({
          field,
          description: `Frontend accepts ${field}=${value} but backend rejects it`,
          example: { [field]: value },
        });
      }
    }
  } finally {
    solver.dispose();
  }

  return { gaps };
}

function buildGapCheck(
  field: string,
  frontend: { min?: number; max?: number },
  backend: { min?: number; max?: number },
): string {
  const lines: string[] = [`(declare-const ${field} Int)`];

  // Value passes frontend validation
  if (frontend.min !== undefined) lines.push(`(assert (>= ${field} ${frontend.min}))`);
  if (frontend.max !== undefined) lines.push(`(assert (<= ${field} ${frontend.max}))`);

  // Value fails backend validation (negate backend constraints)
  const backendConditions: string[] = [];
  if (backend.min !== undefined) backendConditions.push(`(>= ${field} ${backend.min})`);
  if (backend.max !== undefined) backendConditions.push(`(<= ${field} ${backend.max})`);

  if (backendConditions.length > 0) {
    const backendValid = backendConditions.length === 1
      ? backendConditions[0]
      : `(and ${backendConditions.join(" ")})`;
    lines.push(`(assert (not ${backendValid}))`);
  }

  return lines.join("\n");
}
