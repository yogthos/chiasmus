import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("state-machine-deadlock template", () => {
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

  it("is found by search for state machine deadlock", () => {
    const results = library.search(
      "check state machine for dead states unreachable transitions or deadlocks"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("state-machine-deadlock");
  });

  it("is found by search for unreachable state", () => {
    const results = library.search(
      "find unreachable states in a workflow or protocol"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("state-machine-deadlock");
  });

  it("template has matching slots and skeleton", () => {
    const item = library.get("state-machine-deadlock");
    expect(item).not.toBeNull();
    const t = item!.template;

    const slotPattern = /\{\{SLOT:(\w+)\}\}/g;
    const foundSlots = new Set<string>();
    let match;
    while ((match = slotPattern.exec(t.skeleton)) !== null) {
      foundSlots.add(match[1]);
    }
    const definedSlots = new Set(t.slots.map((s) => s.name));
    for (const found of foundSlots) {
      expect(definedSlots.has(found), `slot ${found} in skeleton but not defined`).toBe(true);
    }
    for (const defined of definedSlots) {
      expect(foundSlots.has(defined), `slot ${defined} defined but not in skeleton`).toBe(true);
    }
  });

  it("has at least one normalization", () => {
    const item = library.get("state-machine-deadlock");
    expect(item).not.toBeNull();
    expect(item!.template.normalizations.length).toBeGreaterThan(0);
  });

  describe("dogfood: solver verification", () => {
    it("finds a reachable target state (SAT)", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-datatypes ((State 0)) (((idle) (running) (done) (error))))
(declare-const transition_holds Bool)
(declare-const from State)
(declare-const to State)

(assert (= transition_holds (or
  (and (= from idle) (= to running))
  (and (= from running) (= to done))
  (and (= from running) (= to error))
)))

; Can we go from idle to running? (yes, direct transition)
(assert (= from idle))
(assert (= to running))
`,
        });
        expect(result.status).toBe("sat");
      } finally {
        solver.dispose();
      }
    });

    it("proves a state is unreachable (UNSAT)", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-datatypes ((State 0)) (((draft) (review) (approved) (rejected))))

(declare-const from State)
(declare-const to State)

; Transitions: draft→review, review→approved, review→rejected, rejected→draft
(assert (or
  (and (= from draft) (= to review))
  (and (= from review) (= to approved))
  (and (= from review) (= to rejected))
  (and (= from rejected) (= to draft))
))

; Can we go directly from draft to approved? (no — must go through review)
(assert (= from draft))
(assert (= to approved))
`,
        });
        expect(result.status).toBe("unsat");
      } finally {
        solver.dispose();
      }
    });

    it("detects conflicting state assignments", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-datatypes ((State 0)) (((s1) (s2) (s3))))

(declare-const current_state State)

; Two rules that assign different states simultaneously
(declare-const rule1_sets State)
(declare-const rule2_sets State)

(assert (= rule1_sets s2))
(assert (= rule2_sets s3))

; Both rules fire
(assert (= current_state rule1_sets))
(assert (= current_state rule2_sets))
`,
        });
        expect(result.status).toBe("unsat");
      } finally {
        solver.dispose();
      }
    });
  });
});
