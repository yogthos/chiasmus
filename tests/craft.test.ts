import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateTemplate, craftTemplate } from "../src/skills/craft.js";
import { SkillLibrary } from "../src/skills/library.js";
import type { CraftInput } from "../src/skills/craft.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function validInput(overrides: Partial<CraftInput> = {}): CraftInput {
  return {
    name: "test-template",
    domain: "validation",
    solver: "z3",
    signature: "Check if two validation rule sets are consistent",
    skeleton: `{{SLOT:declarations}}\n(assert (not (= {{SLOT:rule_a}} {{SLOT:rule_b}})))`,
    slots: [
      { name: "declarations", description: "Variable declarations", format: "(declare-const x Int)" },
      { name: "rule_a", description: "First rule expression", format: "(> x 0)" },
      { name: "rule_b", description: "Second rule expression", format: "(> x 0)" },
    ],
    normalizations: [
      { source: "JSON Schema", transform: "Map each property constraint to an SMT expression" },
    ],
    ...overrides,
  };
}

describe("validateTemplate", () => {
  let tempDir: string;
  let library: SkillLibrary;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-craft-test-"));
    library = await SkillLibrary.create(tempDir);
  });

  afterEach(async () => {
    library?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("valid template passes validation with no errors", () => {
    const errors = validateTemplate(validInput(), library);
    expect(errors).toHaveLength(0);
  });

  it("missing required field returns specific error", () => {
    const errors = validateTemplate(validInput({ name: "" }), library);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("invalid solver returns error", () => {
    const errors = validateTemplate(validInput({ solver: "invalid" }), library);
    expect(errors.some((e) => e.includes("solver"))).toBe(true);
  });

  it("slot in skeleton not in slots array returns error", () => {
    const input = validInput({
      skeleton: "{{SLOT:declarations}}\n{{SLOT:missing_slot}}",
      slots: [
        { name: "declarations", description: "Decls", format: "..." },
      ],
    });
    const errors = validateTemplate(input, library);
    expect(errors.some((e) => e.includes("missing_slot") && e.includes("not defined"))).toBe(true);
  });

  it("slot in array not in skeleton returns error", () => {
    const input = validInput({
      skeleton: "{{SLOT:declarations}}",
      slots: [
        { name: "declarations", description: "Decls", format: "..." },
        { name: "extra_slot", description: "Extra", format: "..." },
      ],
    });
    const errors = validateTemplate(input, library);
    expect(errors.some((e) => e.includes("extra_slot") && e.includes("not referenced"))).toBe(true);
  });

  it("duplicate name returns error", async () => {
    // First add a template
    await craftTemplate(validInput(), library);
    // Try to validate another with same name
    const errors = validateTemplate(validInput(), library);
    expect(errors.some((e) => e.includes("already exists"))).toBe(true);
  });

  it("empty slots array returns error", () => {
    const errors = validateTemplate(validInput({ slots: [] }), library);
    expect(errors.some((e) => e.includes("slots") && e.includes("non-empty"))).toBe(true);
  });

  it("empty normalizations array returns error", () => {
    const errors = validateTemplate(validInput({ normalizations: [] }), library);
    expect(errors.some((e) => e.includes("normalizations") && e.includes("non-empty"))).toBe(true);
  });
});

describe("craftTemplate", () => {
  let tempDir: string;
  let library: SkillLibrary;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-craft-test-"));
    library = await SkillLibrary.create(tempDir);
  });

  afterEach(async () => {
    library?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("valid template is added to library and searchable", async () => {
    const result = await craftTemplate(validInput(), library);
    expect(result.created).toBe(true);
    expect(result.template).toBe("test-template");

    // Verify it's searchable
    const found = library.search("validation rule sets consistent");
    expect(found.some((s) => s.template.name === "test-template")).toBe(true);
  });

  it("template with test=true and valid Z3 example runs solver", async () => {
    const result = await craftTemplate(validInput({
      example: `
        (declare-const x Int)
        (assert (> x 0))
        (assert (< x 10))
      `,
      test: true,
    }), library);

    expect(result.created).toBe(true);
    expect(result.tested).toBe(true);
    expect(result.testResult).toBe("sat");
  });

  it("template with test=true and broken example returns error but still creates", async () => {
    const result = await craftTemplate(validInput({
      example: `(declare-const x Int) (assert (> x "bad"))`,
      test: true,
    }), library);

    expect(result.created).toBe(true);
    expect(result.tested).toBe(true);
    expect(result.testResult).toBe("error");
  });

  it("template with test=true and valid Prolog example runs solver", async () => {
    const result = await craftTemplate(validInput({
      solver: "prolog",
      skeleton: "{{SLOT:facts}}\n{{SLOT:rules}}",
      slots: [
        { name: "facts", description: "Facts", format: "parent(tom, bob)." },
        { name: "rules", description: "Rules", format: "ancestor(X,Y) :- parent(X,Y)." },
      ],
      example: "parent(tom, bob).\nparent(bob, ann).\n?- parent(tom, X).",
      test: true,
    }), library);

    expect(result.created).toBe(true);
    expect(result.tested).toBe(true);
    expect(result.testResult).toBe("success");
  });

  it("validation errors prevent creation", async () => {
    const result = await craftTemplate(validInput({ solver: "invalid" }), library);
    expect(result.created).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});
