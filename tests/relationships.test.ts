import { describe, it, expect } from "vitest";
import { getRelatedTemplates } from "../src/skills/relationships.js";
import { STARTER_TEMPLATES } from "../src/skills/starters.js";

describe("getRelatedTemplates", () => {
  it("returns related templates for policy-contradiction", () => {
    const related = getRelatedTemplates("policy-contradiction");
    const names = related.map((r) => r.name);
    expect(names).toContain("policy-reachability");
    expect(names).toContain("permission-derivation");
  });

  it("returns related templates for schema-consistency", () => {
    const related = getRelatedTemplates("schema-consistency");
    const names = related.map((r) => r.name);
    expect(names).toContain("config-equivalence");
    expect(names).toContain("constraint-satisfaction");
  });

  it("returns empty array for unknown template", () => {
    const related = getRelatedTemplates("nonexistent");
    expect(related).toEqual([]);
  });

  it("all starter templates have at least one related template", () => {
    for (const template of STARTER_TEMPLATES) {
      const related = getRelatedTemplates(template.name);
      expect(related.length, `${template.name} should have related templates`).toBeGreaterThan(0);
    }
  });

  it("all reason strings are non-empty and descriptive", () => {
    for (const template of STARTER_TEMPLATES) {
      const related = getRelatedTemplates(template.name);
      for (const r of related) {
        expect(r.reason.length, `${template.name} → ${r.name} reason`).toBeGreaterThan(10);
      }
    }
  });
});
