import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { SkillLearner } from "../src/skills/learner.js";
import { MockLLMAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SkillLearner", () => {
  let tempDir: string;
  let library: SkillLibrary;
  let llm: MockLLMAdapter;
  let learner: SkillLearner;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-learn-test-"));
    library = await SkillLibrary.create(tempDir);
    llm = new MockLLMAdapter();
    learner = new SkillLearner(library, llm);
  });

  afterEach(async () => {
    library?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("template extraction", () => {
    it("extracts a Z3 template from a verified solution", async () => {
      llm.onMatch(/./, JSON.stringify({
        name: "port-range-overlap",
        domain: "configuration",
        signature: "Check if two port ranges overlap",
        slots: [
          { name: "range_declarations", description: "Port range variables", format: "(declare-const port Int)" },
          { name: "range_a_constraints", description: "First port range bounds", format: "(assert (and (>= port 80) (<= port 443)))" },
          { name: "range_b_constraints", description: "Second port range bounds", format: "(assert (and (>= port 8080) (<= port 8443)))" },
        ],
        normalizations: [
          { source: "firewall rules", transform: "Extract port ranges from rule definitions" },
        ],
        skeleton: "(declare-const port Int)\n{{SLOT:range_a_constraints}}\n{{SLOT:range_b_constraints}}",
      }));

      const result = await learner.extractTemplate(
        "z3",
        `(declare-const port Int)
(assert (and (>= port 80) (<= port 443)))
(assert (and (>= port 8080) (<= port 8443)))`,
        "Check if ports 80-443 and 8080-8443 overlap",
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe("port-range-overlap");
      expect(result!.solver).toBe("z3");

      // Verify it was added to the library
      const found = library.get("port-range-overlap");
      expect(found).not.toBeNull();
      expect(found!.metadata.promoted).toBe(false); // candidate, not promoted
    });

    it("extracts a Prolog template from a verified solution", async () => {
      llm.onMatch(/./, JSON.stringify({
        name: "dependency-ordering",
        domain: "analysis",
        signature: "Determine a valid execution order respecting dependencies",
        slots: [
          { name: "dependencies", description: "Dependency edges", format: "depends(build, compile)." },
        ],
        normalizations: [
          { source: "Makefile", transform: "Extract target dependencies as depends/2 facts" },
        ],
        skeleton: "{{SLOT:dependencies}}\ncan_run_before(A, B) :- depends(B, A).\ncan_run_before(A, B) :- depends(B, Mid), can_run_before(A, Mid).",
      }));

      const result = await learner.extractTemplate(
        "prolog",
        `depends(build, compile).
depends(test, build).
can_run_before(A, B) :- depends(B, A).
can_run_before(A, B) :- depends(B, Mid), can_run_before(A, Mid).`,
        "Determine build order for compilation pipeline",
      );

      expect(result).not.toBeNull();
      expect(result!.solver).toBe("prolog");
    });

    it("returns null when LLM produces invalid JSON", async () => {
      llm.onMatch(/./, "this is not valid json at all");

      const result = await learner.extractTemplate(
        "z3",
        "(declare-const x Int) (assert (> x 5))",
        "Find a number greater than 5",
      );

      expect(result).toBeNull();
    });

    it("rejects templates with missing required fields", async () => {
      llm.onMatch(/./, JSON.stringify({
        name: "incomplete",
        // missing: domain, signature, slots, skeleton
      }));

      const result = await learner.extractTemplate(
        "z3",
        "(declare-const x Int)",
        "test",
      );

      expect(result).toBeNull();
    });
  });

  describe("deduplication", () => {
    it("rejects near-duplicate templates", async () => {
      // First, add a template manually
      llm.onMatch(/./, JSON.stringify({
        name: "policy-conflict-check",
        domain: "authorization",
        signature: "Check if access control rules can ever produce contradictory allow/deny decisions for the same request",
        slots: [
          { name: "rules", description: "Policy rules", format: "(assert ...)" },
        ],
        normalizations: [
          { source: "IAM", transform: "Map policies to assertions" },
        ],
        skeleton: "{{SLOT:rules}}",
      }));

      const result = await learner.extractTemplate(
        "z3",
        "(declare-const x Bool)",
        "Check policy conflicts",
      );

      // Should be rejected — too similar to existing "policy-contradiction"
      expect(result).toBeNull();
    });
  });

  describe("promotion and quality tracking", () => {
    it("promotes a template after sufficient successful reuses", async () => {
      // Add a learned template
      llm.onMatch(/./, JSON.stringify({
        name: "unique-test-template",
        domain: "validation",
        signature: "A completely unique template for testing promotion",
        slots: [{ name: "input", description: "test input", format: "test" }],
        normalizations: [{ source: "test", transform: "test" }],
        skeleton: "{{SLOT:input}}",
      }));

      await learner.extractTemplate("z3", "(declare-const x Int)", "unique test");

      const meta = library.getMetadata("unique-test-template");
      expect(meta).not.toBeNull();
      expect(meta!.promoted).toBe(false);

      // Simulate successful reuses
      const PROMOTION_THRESHOLD = 3;
      for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
        library.recordUse("unique-test-template", true);
      }
      learner.checkPromotions();

      const updated = library.getMetadata("unique-test-template");
      expect(updated!.promoted).toBe(true);
    });

    it("does not promote templates with low success rate", async () => {
      llm.onMatch(/./, JSON.stringify({
        name: "flaky-template",
        domain: "validation",
        signature: "A template that mostly fails for testing non-promotion",
        slots: [{ name: "input", description: "test", format: "test" }],
        normalizations: [{ source: "test", transform: "test" }],
        skeleton: "{{SLOT:input}}",
      }));

      await learner.extractTemplate("z3", "(declare-const x Int)", "flaky test");

      // 3 uses but only 1 success
      library.recordUse("flaky-template", true);
      library.recordUse("flaky-template", false);
      library.recordUse("flaky-template", false);
      learner.checkPromotions();

      const meta = library.getMetadata("flaky-template");
      expect(meta!.promoted).toBe(false);
    });
  });
});
