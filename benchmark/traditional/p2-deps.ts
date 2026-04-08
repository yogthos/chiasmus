interface DependencyResult {
  satisfiable: boolean;
  assignment?: Record<string, number>;
}

export async function solveTraditional(input: {
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
  const pkgNames = Object.keys(input.packages);

  function isValid(assignment: Record<string, number>): boolean {
    for (const req of input.requirements) {
      const pkgVer = assignment[req.package];
      if (pkgVer === undefined) continue;
      // Skip conditional requirements that don't apply
      if (req.condition !== undefined && pkgVer < req.condition) continue;
      const depVer = assignment[req.requires];
      if (depVer === undefined) continue;
      if (depVer < req.minVersion) return false;
    }
    for (const inc of input.incompatibilities) {
      if (assignment[inc.packageA] === inc.versionA &&
          assignment[inc.packageB] === inc.versionB) {
        return false;
      }
    }
    return true;
  }

  function backtrack(idx: number, assignment: Record<string, number>): Record<string, number> | null {
    if (idx === pkgNames.length) {
      return isValid(assignment) ? { ...assignment } : null;
    }
    const pkg = pkgNames[idx];
    for (const ver of input.packages[pkg].versions) {
      assignment[pkg] = ver;
      if (isValid(assignment)) {
        const result = backtrack(idx + 1, assignment);
        if (result) return result;
      }
    }
    delete assignment[pkg];
    return null;
  }

  const assignment = backtrack(0, {});
  return assignment
    ? { satisfiable: true, assignment }
    : { satisfiable: false };
}
