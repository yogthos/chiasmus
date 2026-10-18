import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateTemplate, craftTemplate } from "../src/skills/craft.js";
import { SkillLibrary } from "../src/skills/library.js";
import { SolverSession } from "../src/solvers/session.js";
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

function prologInput(example: string): CraftInput {
  return validInput({
    solver: "prolog",
    skeleton: "{{SLOT:facts}}\n{{SLOT:rules}}",
    slots: [
      { name: "facts", description: "Facts", format: "parent(tom, bob)." },
      { name: "rules", description: "Rules", format: "ancestor(X,Y) :- parent(X,Y)." },
    ],
    example,
    test: true,
  });
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

  it("non-string example returns error", () => {
    for (const example of [{ text: "(assert true)" }, ["(assert true)"], 42, true]) {
      const errors = validateTemplate(
        validInput({ example: example as unknown as string }),
        library,
      );
      expect(errors.some((e) => e.includes("'example'")), JSON.stringify(example)).toBe(true);
    }
  });

  it("tips that is not an array of strings returns error", () => {
    for (const tips of ["one tip", [1, 2], [["nested"]], ["ok", null], { 0: "tip" }]) {
      const errors = validateTemplate(
        validInput({ tips: tips as unknown as string[] }),
        library,
      );
      expect(errors.some((e) => e.includes("'tips'")), JSON.stringify(tips)).toBe(true);
    }
  });

  it("string example and string tips pass, and null counts as absent", () => {
    const given = validInput({ example: "(assert true)", tips: ["declare before use"] });
    expect(validateTemplate(given, library)).toHaveLength(0);

    const nulls = validInput({
      example: null as unknown as undefined,
      tips: null as unknown as undefined,
    });
    expect(validateTemplate(nulls, library)).toHaveLength(0);
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
    vi.restoreAllMocks();
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

  it("template with test=true and broken example is refused with the solver's message and stores nothing", async () => {
    const result = await craftTemplate(validInput({
      example: `(declare-const x Int) (assert (> x "bad"))`,
      test: true,
    }), library);

    expect(result.created).toBe(false);
    expect(result.tested).toBe(true);
    expect(result.testResult).toBe("error");
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toContain("not stored");
    expect(result.errors![0]).toContain("Sort mismatch");
    expect(library.get("test-template")).toBeNull();

    library.close();
    library = await SkillLibrary.create(tempDir);
    expect(library.get("test-template")).toBeNull();

    // Nothing holds the name, so the fixed example goes in under it.
    const fixed = await craftTemplate(validInput({
      example: `(declare-const x Int) (assert (> x 0))`,
      test: true,
    }), library);
    expect(fixed.created).toBe(true);
    expect(fixed.testResult).toBe("sat");
  });

  it("template with test=true and a Prolog example the solver errors on is refused", async () => {
    const result = await craftTemplate(prologInput("parent(tom, bob).\n?- ancestor(tom, X)."), library);

    expect(result.created).toBe(false);
    expect(result.testResult).toBe("error");
    expect(result.errors![0]).toContain("existence_error");
    expect(library.get("test-template")).toBeNull();
  });

  it("template with test=true is refused when the solver session cannot start", async () => {
    vi.spyOn(SolverSession, "create").mockRejectedValueOnce(new Error("solver unavailable"));

    const result = await craftTemplate(validInput({
      example: `(declare-const x Int) (assert (> x 0))`,
      test: true,
    }), library);

    expect(result.created).toBe(false);
    expect(result.tested).toBe(true);
    expect(result.testResult).toBe("error: solver unavailable");
    expect(result.errors![0]).toContain("solver unavailable");
    expect(library.get("test-template")).toBeNull();
  });

  // An example may show the no-conflict or no-path case on purpose, so only
  // an example the solver could not run is refused.
  it("template with test=true and an unsat example is stored", async () => {
    const result = await craftTemplate(validInput({
      example: `(declare-const x Int) (assert (> x 0)) (assert (< x 0))`,
      test: true,
    }), library);

    expect(result.created).toBe(true);
    expect(result.testResult).toBe("unsat");
    expect(library.get("test-template")).not.toBeNull();
  });

  it("template with test=true and a Prolog query without answers is stored", async () => {
    const result = await craftTemplate(prologInput("parent(tom, bob).\n?- parent(bob, tom)."), library);

    expect(result.created).toBe(true);
    expect(result.testResult).toBe("success");
    expect(library.get("test-template")).not.toBeNull();
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

  it("non-string example is a validation error, not a thrown bind error", async () => {
    const result = await craftTemplate(
      validInput({ example: { text: "(assert true)" } as unknown as string }),
      library,
    );

    expect(result.created).toBe(false);
    expect(result.errors!.some((e) => e.includes("'example'"))).toBe(true);
    expect(library.get("test-template")).toBeNull();
  });

  it("tips that is not an array of strings is a validation error and stores nothing", async () => {
    const result = await craftTemplate(
      validInput({ tips: "one tip" as unknown as string[] }),
      library,
    );

    expect(result.created).toBe(false);
    expect(result.errors!.some((e) => e.includes("'tips'"))).toBe(true);
    expect(library.get("test-template")).toBeNull();
  });

  it("null example and tips are stored as absent, the same as a reopened library serves them", async () => {
    const result = await craftTemplate(
      validInput({
        example: null as unknown as undefined,
        tips: null as unknown as undefined,
      }),
      library,
    );
    expect(result.created).toBe(true);

    const running = library.get("test-template")!.template;
    expect(running.example).toBeUndefined();
    expect(running.tips).toBeUndefined();

    library.close();
    library = await SkillLibrary.create(tempDir);
    expect(library.get("test-template")!.template).toEqual(running);
  });

  it("says the name is taken on disk when another process sharing the directory stored it", async () => {
    // A second process stores the name after this instance loaded, so the
    // name is on disk but not in this instance, and validation here passes.
    const other = await SkillLibrary.create(tempDir);
    try {
      expect((await craftTemplate(validInput(), other)).created).toBe(true);
    } finally {
      other.close();
    }

    const result = await craftTemplate(
      validInput({ signature: "a second definition under the taken name" }),
      library,
    );

    expect(result.created).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toContain('"test-template"');
    expect(result.errors![0]).toContain("already taken on disk");
    expect(result.errors![0]).toContain("restart");
    expect(library.get("test-template")).toBeNull();
  });

  it("says the template already exists when this instance added the name after validation", async () => {
    // Both calls validate before either adds: each waits on its solver run
    // first. The one that adds second is refused for a name held in memory.
    const tested = () =>
      craftTemplate(
        validInput({
          solver: "prolog",
          skeleton: "{{SLOT:facts}}\n{{SLOT:rules}}",
          slots: [
            { name: "facts", description: "Facts", format: "parent(tom, bob)." },
            { name: "rules", description: "Rules", format: "ancestor(X,Y) :- parent(X,Y)." },
          ],
          example: "parent(tom, bob).\n?- parent(tom, X).",
          test: true,
        }),
        library,
      );

    const results = await Promise.all([tested(), tested()]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    const refused = results.find((r) => !r.created)!;
    expect(refused.errors).toEqual(['Template "test-template" already exists in library']);
    expect(library.get("test-template")).not.toBeNull();
  });
});
