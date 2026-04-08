import { describe, it, expect } from "vitest";
import { packageConstraints } from "../problems/definitions.js";
import { solveTraditional } from "../traditional/p2-deps.js";
import { solveChiasmus } from "../chiasmus/p2-deps.js";

interface DependencyResult {
  satisfiable: boolean;
  assignment?: Record<string, number>;
}

function runSuite(name: string, solve: (constraints: typeof packageConstraints) => Promise<DependencyResult>) {
  describe(name, () => {
    it("finds a satisfiable assignment", async () => {
      const result = await solve(packageConstraints);
      expect(result.satisfiable).toBe(true);
      expect(result.assignment).toBeDefined();
    });

    it("all versions are within allowed ranges", async () => {
      const result = await solve(packageConstraints);
      const a = result.assignment!;
      for (const [pkg, info] of Object.entries(packageConstraints.packages)) {
        expect(info.versions).toContain(a[pkg]);
      }
    });

    it("respects dependency requirements", async () => {
      const result = await solve(packageConstraints);
      const a = result.assignment!;
      for (const req of packageConstraints.requirements) {
        // Skip conditional requirements that don't apply
        if (req.condition !== undefined && a[req.package] < req.condition) continue;
        expect(a[req.requires]).toBeGreaterThanOrEqual(req.minVersion);
      }
    });

    it("respects incompatibilities", async () => {
      const result = await solve(packageConstraints);
      const a = result.assignment!;
      for (const inc of packageConstraints.incompatibilities) {
        const bothMatch = a[inc.packageA] === inc.versionA && a[inc.packageB] === inc.versionB;
        expect(bothMatch).toBe(false);
      }
    });
  });
}

describe("Problem 2: Package Dependency Resolution", () => {
  runSuite("Traditional", solveTraditional);
  runSuite("Chiasmus", solveChiasmus);
});
