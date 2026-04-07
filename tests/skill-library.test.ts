import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { STARTER_TEMPLATES } from "../src/skills/starters.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SkillLibrary", () => {
  let tempDir: string;
  let library: SkillLibrary;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-test-"));
    library = await SkillLibrary.create(tempDir);
  });

  afterEach(async () => {
    library?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("loads all starter templates", () => {
      const all = library.list();
      expect(all.length).toBe(STARTER_TEMPLATES.length);
    });

    it("each template has metadata initialized", () => {
      const all = library.list();
      for (const item of all) {
        expect(item.metadata.reuseCount).toBe(0);
        expect(item.metadata.successCount).toBe(0);
        expect(item.metadata.lastUsed).toBeNull();
        expect(item.metadata.promoted).toBe(true); // starters are pre-promoted
      }
    });
  });

  describe("search", () => {
    it("finds policy-contradiction for authorization conflict queries", () => {
      const results = library.search("do these access control rules conflict or contradict");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].template.name).toBe("policy-contradiction");
    });

    it("finds constraint-satisfaction for dependency version queries", () => {
      const results = library.search("resolve package version dependency constraints");
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.template.name);
      expect(names).toContain("constraint-satisfaction");
    });

    it("finds graph-reachability for data flow queries", () => {
      const results = library.search("can data flow from user input to the database");
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.template.name);
      expect(names).toContain("graph-reachability");
    });

    it("finds config-equivalence for configuration comparison", () => {
      const results = library.search("are these two firewall configurations equivalent");
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.template.name);
      expect(names).toContain("config-equivalence");
    });

    it("finds rule-inference for eligibility/compliance queries", () => {
      const results = library.search("determine eligibility based on business rules and facts");
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.template.name);
      expect(names).toContain("rule-inference");
    });

    it("finds permission-derivation for role hierarchy queries", () => {
      const results = library.search(
        "what can this user do given their role and the permission hierarchy"
      );
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.template.name);
      expect(names).toContain("permission-derivation");
    });

    it("returns results sorted by relevance score", () => {
      const results = library.search("check authorization policies");
      expect(results.length).toBeGreaterThan(1);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("can filter by domain", () => {
      const results = library.search("check rules", { domain: "authorization" });
      for (const r of results) {
        expect(r.template.domain).toBe("authorization");
      }
    });

    it("can filter by solver type", () => {
      const results = library.search("check rules", { solver: "prolog" });
      for (const r of results) {
        expect(r.template.solver).toBe("prolog");
      }
    });
  });

  describe("template structure", () => {
    it("all templates have valid skeletons with matching slot markers", () => {
      const all = library.list();
      for (const item of all) {
        const t = item.template;
        const slotPattern = /\{\{SLOT:(\w+)\}\}/g;
        const foundSlots = new Set<string>();
        let match;
        while ((match = slotPattern.exec(t.skeleton)) !== null) {
          foundSlots.add(match[1]);
        }
        const definedSlots = new Set(t.slots.map((s) => s.name));
        // Every slot in skeleton should be defined
        for (const found of foundSlots) {
          expect(definedSlots.has(found), `Template ${t.name}: slot ${found} in skeleton but not in slots[]`).toBe(true);
        }
        // Every defined slot should appear in skeleton
        for (const defined of definedSlots) {
          expect(foundSlots.has(defined), `Template ${t.name}: slot ${defined} defined but not in skeleton`).toBe(true);
        }
      }
    });

    it("all templates have at least one normalization", () => {
      const all = library.list();
      for (const item of all) {
        expect(
          item.template.normalizations.length,
          `Template ${item.template.name} has no normalizations`
        ).toBeGreaterThan(0);
      }
    });
  });

  describe("metadata tracking", () => {
    it("records reuse and success", async () => {
      library.recordUse("policy-contradiction", true);
      library.recordUse("policy-contradiction", true);
      library.recordUse("policy-contradiction", false);

      const meta = library.getMetadata("policy-contradiction");
      expect(meta).not.toBeNull();
      expect(meta!.reuseCount).toBe(3);
      expect(meta!.successCount).toBe(2);
      expect(meta!.lastUsed).not.toBeNull();
    });

    it("persists metadata across library instances", async () => {
      library.recordUse("graph-reachability", true);
      library.close();

      const library2 = await SkillLibrary.create(tempDir);
      const meta = library2.getMetadata("graph-reachability");
      expect(meta).not.toBeNull();
      expect(meta!.reuseCount).toBe(1);
      expect(meta!.successCount).toBe(1);
      library2.close();
    });
  });

  describe("get by name", () => {
    it("retrieves a template by exact name", () => {
      const result = library.get("policy-contradiction");
      expect(result).not.toBeNull();
      expect(result!.template.name).toBe("policy-contradiction");
    });

    it("returns null for unknown name", () => {
      const result = library.get("nonexistent");
      expect(result).toBeNull();
    });
  });
});
