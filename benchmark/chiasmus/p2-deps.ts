import { createZ3Solver } from "../../src/solvers/z3-solver.js";

interface DependencyResult {
  satisfiable: boolean;
  assignment?: Record<string, number>;
}

export async function solveChiasmus(input: {
  packages: Record<string, { versions: number[] }>;
  requirements: Array<{
    package: string;
    condition?: number;
    requires: string;
    minVersion: number;
  }>;
  incompatibilities: Array<{
    packageA: string;
    versionA: number;
    packageB: string;
    versionB: number;
  }>;
}): Promise<DependencyResult> {
  const solver = await createZ3Solver();
  const pkgNames = Object.keys(input.packages);

  // Declare a version variable per package
  const decls = pkgNames
    .map((p) => `(declare-const ${p} Int)`)
    .join("\n");

  // Constrain each to its available versions
  const ranges = pkgNames
    .map((p) => {
      const versions = input.packages[p].versions;
      const orClauses = versions.map((v) => `(= ${p} ${v})`).join(" ");
      return `(assert (or ${orClauses}))`;
    })
    .join("\n");

  // Dependency requirements
  const deps = input.requirements
    .map((r) => {
      const constraint = `(>= ${r.requires} ${r.minVersion})`;
      if (r.condition !== undefined) {
        return `(assert (=> (>= ${r.package} ${r.condition}) ${constraint}))`;
      }
      return `(assert ${constraint})`;
    })
    .join("\n");

  // Incompatibilities
  const incompat = input.incompatibilities
    .map((i) => `(assert (not (and (= ${i.packageA} ${i.versionA}) (= ${i.packageB} ${i.versionB}))))`)
    .join("\n");

  const smtlib = `${decls}\n${ranges}\n${deps}\n${incompat}`;

  try {
    const result = await solver.solve({ type: "z3", smtlib });
    if (result.status === "sat") {
      const assignment: Record<string, number> = {};
      for (const pkg of pkgNames) {
        assignment[pkg] = parseInt(result.model[pkg], 10);
      }
      return { satisfiable: true, assignment };
    }
    return { satisfiable: false };
  } finally {
    solver.dispose();
  }
}
