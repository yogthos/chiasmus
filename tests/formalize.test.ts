import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FormalizationEngine } from "../src/formalize/engine.js";
import { SkillLibrary } from "../src/skills/library.js";
import { MockLLMAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("FormalizationEngine", () => {
  let tempDir: string;
  let library: SkillLibrary;
  let llm: MockLLMAdapter;
  let engine: FormalizationEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-formalize-test-"));
    library = await SkillLibrary.create(tempDir);
    llm = new MockLLMAdapter();
    engine = new FormalizationEngine(library, llm);
  });

  afterEach(async () => {
    library?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("formalize (template + instructions, no execution)", () => {
    it("selects the right template for a policy conflict problem", async () => {
      const result = await engine.formalize(
        "Check if our RBAC rules can ever allow and deny the same user accessing the same resource"
      );

      expect(result.template.name).toBe("policy-contradiction");
      expect(result.template.solver).toBe("z3");
      expect(result.instructions).toBeTruthy();
      expect(result.instructions).toContain("SLOT");
    });

    it("selects a Prolog template for rule inference problems", async () => {
      const result = await engine.formalize(
        "Given these business rules and employee data, determine who is eligible for promotion"
      );

      expect(result.template.solver).toBe("prolog");
      const name = result.template.name;
      expect(["rule-inference", "permission-derivation"]).toContain(name);
    });

    it("selects graph-reachability for data flow problems", async () => {
      const result = await engine.formalize(
        "Can user input reach the database through any chain of function calls?"
      );

      expect(result.template.name).toBe("graph-reachability");
    });

    it("selects constraint-satisfaction for dependency problems", async () => {
      const result = await engine.formalize(
        "Find compatible versions for these npm packages given their peer dependency constraints"
      );

      expect(result.template.name).toBe("constraint-satisfaction");
    });

    it("includes normalization guidance in instructions", async () => {
      const result = await engine.formalize(
        "Check if our Kubernetes RBAC roles have conflicting permissions"
      );

      expect(result.instructions).toContain("Kubernetes");
    });
  });

  describe("solve (end-to-end with LLM)", () => {
    it("solves a Z3 policy contradiction problem end-to-end", async () => {
      llm.onMatch(/./, `
(declare-datatypes ((Role 0)) (((admin) (editor))))
(declare-datatypes ((Resource 0)) (((docs) (settings))))
(declare-datatypes ((Action 0)) (((read) (write))))

(declare-const principal Role)
(declare-const resource Resource)
(declare-const action Action)
(declare-const allowed Bool)
(declare-const denied Bool)

(assert (=> (and (= principal editor) (= action write) (= resource docs)) allowed))
(assert (=> (and (= principal editor) (= action write) (= resource settings)) denied))

(assert allowed)
(assert denied)
      `.trim());

      const result = await engine.solve(
        "Can an editor ever be both allowed and denied write access?"
      );

      expect(result.converged).toBe(true);
      expect(result.result.status).toBe("sat");
      expect(result.templateUsed).toBeTruthy();
    });

    it("solves a Prolog reachability problem end-to-end", async () => {
      llm.onMatch(/./, `
edge(user_input, api_handler).
edge(api_handler, validator).
edge(validator, database).
edge(api_handler, logger).

reaches(A, B) :- edge(A, B).
reaches(A, B) :- edge(A, Mid), reaches(Mid, B).

?- reaches(user_input, database).
      `.trim());

      const result = await engine.solve(
        "Can user input data reach the database through any chain of calls in this directed graph?"
      );

      expect(result.converged).toBe(true);
      expect(result.result.status).toBe("success");
      expect(result.answers.length).toBeGreaterThanOrEqual(1);
    });

    it("uses correction loop when initial formalization has errors", async () => {
      let calls = 0;
      llm.onMatch(/./, () => {
        calls++;
        if (calls <= 1) {
          return `(declare-const x Int) (assert (> x "bad"))`;
        }
        return `(declare-const x Int) (assert (> x 5))`;
      });

      const result = await engine.solve("Find an integer greater than 5");

      expect(result.converged).toBe(true);
      expect(result.rounds).toBeGreaterThan(1);
      expect(result.result.status).toBe("sat");
    });

    it("returns failure with diagnostics when correction loop exhausts", async () => {
      llm.onMatch(/./, `(declare-const x Int) (assert (> x "always_broken"))`);

      const result = await engine.solve("impossible to formalize correctly", 3);

      expect(result.converged).toBe(false);
      expect(result.history.length).toBeGreaterThan(0);
      expect(result.result.status).toBe("error");
    });

    it("uses enriched feedback in correction prompts", async () => {
      const prompts: string[] = [];
      let calls = 0;
      llm.onMatch(/./, () => {
        calls++;
        // Track what prompts the LLM receives
        return calls <= 2
          ? `(declare-const x Int) (assert (> x "broken"))`
          : `(declare-const x Int) (assert (> x 5))`;
      });

      // Override complete to capture prompts
      const origComplete = llm.complete.bind(llm);
      llm.complete = async (system: string, messages: Array<{ role: string; content: string }>) => {
        for (const m of messages) {
          prompts.push(m.content);
        }
        return origComplete(system, messages);
      };

      await engine.solve("Find an integer greater than 5");

      // At least one prompt should contain "FEEDBACK" or error info (not just "ERROR")
      const fixPrompts = prompts.filter((p) => p.includes("FEEDBACK") || p.includes("Solver error"));
      expect(fixPrompts.length).toBeGreaterThan(0);
    });

    it("records template use in skill library", async () => {
      llm.onMatch(/./, `
(declare-const x Int)
(declare-const y Int)
(assert (= (+ x y) 10))
(assert (> x 0))
(assert (> y 0))
      `.trim());

      await engine.solve("Find two positive numbers that add to 10");

      // Check that some template's reuse count increased
      const all = library.list();
      const used = all.find((s) => s.metadata.reuseCount > 0);
      expect(used).toBeTruthy();
    });
  });
});
