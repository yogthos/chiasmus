interface Rule {
  role: string;
  action: string;
  resource: string;
  effect: string;
}

interface ConflictResult {
  hasConflict: boolean;
  conflicts: Array<{ role: string; action: string; resource: string }>;
}

export async function solveTraditional(input: {
  roles: string[];
  resources: string[];
  rules: Rule[];
}): Promise<ConflictResult> {
  const allows = new Map<string, boolean>();
  const denies = new Map<string, boolean>();

  for (const rule of input.rules) {
    const key = `${rule.role}|${rule.action}|${rule.resource}`;
    if (rule.effect === "allow") allows.set(key, true);
    if (rule.effect === "deny") denies.set(key, true);
  }

  const conflicts: Array<{ role: string; action: string; resource: string }> = [];
  for (const key of allows.keys()) {
    if (denies.has(key)) {
      const [role, action, resource] = key.split("|");
      conflicts.push({ role, action, resource });
    }
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}
