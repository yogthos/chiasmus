interface ValidationGapResult {
  gaps: Array<{
    field: string;
    description: string;
    example?: Record<string, unknown>;
  }>;
}

export async function solveTraditional(input: {
  fields: Record<string, { type: string; values?: string[] }>;
  frontend: Record<string, { min?: number; max?: number }>;
  backend: Record<string, { min?: number; max?: number }>;
}): Promise<ValidationGapResult> {
  const gaps: ValidationGapResult["gaps"] = [];

  for (const [field, frontendRule] of Object.entries(input.frontend)) {
    const backendRule = input.backend[field];
    if (!backendRule) continue;

    const fMin = frontendRule.min ?? -Infinity;
    const fMax = frontendRule.max ?? Infinity;
    const bMin = backendRule.min ?? -Infinity;
    const bMax = backendRule.max ?? Infinity;

    // Gap: frontend allows values that backend rejects
    // Case 1: frontend min < backend min (frontend too permissive on low end)
    if (fMin < bMin) {
      gaps.push({
        field,
        description: `Frontend allows ${field} >= ${fMin} but backend requires >= ${bMin}`,
        example: { [field]: fMin },
      });
    }

    // Case 2: frontend max > backend max (frontend too permissive on high end)
    if (fMax > bMax) {
      gaps.push({
        field,
        description: `Frontend allows ${field} <= ${fMax} but backend requires <= ${bMax}`,
        example: { [field]: bMax + 1 },
      });
    }
  }

  return { gaps };
}
