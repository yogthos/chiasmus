import { describe, it, expect } from "vitest";
import { FormalizationEngine } from "../src/formalize/engine.js";
import type { SkillLibrary } from "../src/skills/library.js";
import { MockLLMAdapter } from "../src/llm/mock.js";

function makeEmptyLibrary(): SkillLibrary {
  return {
    search: () => [],
    list: () => [],
    get: () => null,
    getRelated: () => [],
    addLearned: () => false,
    promote: () => {},
    remove: () => {},
    recordUse: () => {},
    getMetadata: () => null,
    close: () => {},
  } as unknown as SkillLibrary;
}

describe("FormalizationEngine", () => {
  it("returns null instead of crashing when library is empty", async () => {
    const library = makeEmptyLibrary();
    const llm = new MockLLMAdapter();
    const engine = new FormalizationEngine(library, llm);

    const result = await engine.formalize("find a contradiction in access policies");
    expect(result).toBeNull();
  });
});
