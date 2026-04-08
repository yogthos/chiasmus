import { describe, it, expect } from "vitest";
import { validationRules } from "../problems/definitions.js";
import { solveTraditional } from "../traditional/p5-validation.js";
import { solveChiasmus } from "../chiasmus/p5-validation.js";

interface ValidationGapResult {
  gaps: Array<{
    field: string;
    description: string;
    example?: Record<string, unknown>;
  }>;
}

function runSuite(name: string, solve: (rules: typeof validationRules) => Promise<ValidationGapResult>) {
  describe(name, () => {
    it("finds the age gap (frontend allows 13-17, backend rejects)", async () => {
      const result = await solve(validationRules);
      const ageGap = result.gaps.find((g) => g.field === "age");
      expect(ageGap).toBeDefined();
    });

    it("finds the username_length gap (frontend allows 21-30, backend max 20)", async () => {
      const result = await solve(validationRules);
      const usernameGap = result.gaps.find((g) => g.field === "username_length");
      expect(usernameGap).toBeDefined();
    });

    it("provides a concrete example for the age gap", async () => {
      const result = await solve(validationRules);
      const ageGap = result.gaps.find((g) => g.field === "age");
      expect(ageGap?.example).toBeDefined();
      const ageVal = ageGap!.example!.age as number;
      // Should be in the gap: passes frontend (13-120) but fails backend (18-150)
      expect(ageVal).toBeGreaterThanOrEqual(13);
      expect(ageVal).toBeLessThan(18);
    });

    it("provides a concrete example for the username_length gap", async () => {
      const result = await solve(validationRules);
      const gap = result.gaps.find((g) => g.field === "username_length");
      expect(gap?.example).toBeDefined();
      const len = gap!.example!.username_length as number;
      // Should be in the gap: passes frontend (3-30) but fails backend (3-20)
      expect(len).toBeGreaterThan(20);
      expect(len).toBeLessThanOrEqual(30);
    });

    it("finds exactly 2 gaps", async () => {
      const result = await solve(validationRules);
      expect(result.gaps.length).toBe(2);
    });
  });
}

describe("Problem 5: API Validation Rule Consistency", () => {
  runSuite("Traditional", solveTraditional);
  runSuite("Chiasmus", solveChiasmus);
});
