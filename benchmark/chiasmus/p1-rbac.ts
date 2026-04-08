import { createZ3Solver } from "../../src/solvers/z3-solver.js";

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

export async function solveChiasmus(input: {
  roles: string[];
  resources: string[];
  rules: Rule[];
}): Promise<ConflictResult> {
  const solver = await createZ3Solver();

  const roles = input.roles.map((r) => `(${r})`).join(" ");
  const resources = input.resources.map((r) => `(${r})`).join(" ");
  const actions = [...new Set(input.rules.map((r) => r.action))];
  const actionsDecl = actions.map((a) => `(${a})`).join(" ");

  const allowRules = input.rules
    .filter((r) => r.effect === "allow")
    .map((r) => `(and (= r ${r.role}) (= a ${r.action}) (= res ${r.resource}))`)
    .join("\n    ");

  const denyRules = input.rules
    .filter((r) => r.effect === "deny")
    .map((r) => `(and (= r ${r.role}) (= a ${r.action}) (= res ${r.resource}))`)
    .join("\n    ");

  const smtlib = `
(declare-datatypes ((Role 0)) ((${roles})))
(declare-datatypes ((Action 0)) ((${actionsDecl})))
(declare-datatypes ((Resource 0)) ((${resources})))
(declare-const r Role)
(declare-const a Action)
(declare-const res Resource)
(declare-const allowed Bool)
(declare-const denied Bool)
(assert (= allowed (or ${allowRules})))
(assert (= denied (or ${denyRules})))
(assert allowed)
(assert denied)`;

  try {
    const result = await solver.solve({ type: "z3", smtlib });
    if (result.status === "sat") {
      return {
        hasConflict: true,
        conflicts: [{
          role: result.model.r,
          action: result.model.a,
          resource: result.model.res,
        }],
      };
    }
    return { hasConflict: false, conflicts: [] };
  } finally {
    solver.dispose();
  }
}
