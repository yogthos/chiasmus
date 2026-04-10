import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { SkillLearner } from "../src/skills/learner.js";
import { MockLLMAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SkillLearner addLearned return check", () => {
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

  it("returns null when addLearned rejects a duplicate name", async () => {
    // Pre-add a template with the name the LLM will produce
    library.addLearned({
      name: "collision-test",
      domain: "configuration",
      solver: "z3",
      signature: "Completely unrelated signature about network config",
      slots: [{ name: "x", description: "test", format: "test" }],
      normalizations: [{ source: "test", transform: "test" }],
      skeleton: "{{SLOT:x}}",
    });

    // LLM returns a template with the same name but different content
    llm.onMatch(/./, JSON.stringify({
      name: "collision-test",
      domain: "authorization",
      signature: "Check RBAC policy conflicts for user access rights",
      slots: [{ name: "rules", description: "Policy rules", format: "(assert ...)" }],
      normalizations: [{ source: "IAM", transform: "Map policies" }],
      skeleton: "{{SLOT:rules}}",
    }));

    const result = await learner.extractTemplate(
      "z3",
      "(declare-const x Int) (assert (> x 5))",
      "Check RBAC policies",
    );

    // Should return null because addLearned returns false for duplicate name
    expect(result).toBeNull();
  });
});
