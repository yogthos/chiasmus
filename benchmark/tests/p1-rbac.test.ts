import { describe, it, expect } from "vitest";
import { rbacRules } from "../problems/definitions.js";
import { solveTraditional } from "../traditional/p1-rbac.js";
import { solveChiasmus } from "../chiasmus/p1-rbac.js";

interface ConflictResult {
  hasConflict: boolean;
  conflicts: Array<{ role: string; action: string; resource: string }>;
}

function runSuite(name: string, solve: (rules: typeof rbacRules) => Promise<ConflictResult>) {
  describe(name, () => {
    it("detects the auditor read/billing conflict", async () => {
      const result = await solve(rbacRules);
      expect(result.hasConflict).toBe(true);
    });

    it("returns the specific conflicting triple", async () => {
      const result = await solve(rbacRules);
      const match = result.conflicts.find(
        (c) => c.role === "auditor" && c.action === "read" && c.resource === "billing"
      );
      expect(match).toBeDefined();
    });

    it("finds exactly one conflict in this ruleset", async () => {
      const result = await solve(rbacRules);
      expect(result.conflicts.length).toBe(1);
    });
  });
}

describe("Problem 1: RBAC Policy Conflict Detection", () => {
  runSuite("Traditional", solveTraditional);
  runSuite("Chiasmus", solveChiasmus);
});
