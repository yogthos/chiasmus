import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("invariant-check template", () => {
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

  it("is found by search for function invariant verification", () => {
    const results = library.search(
      "verify function preconditions and postconditions hold for all inputs"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("invariant-check");
  });

  it("is found by search for invariant counterexample", () => {
    const results = library.search(
      "find a counterexample where a code invariant is violated"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("invariant-check");
  });

  it("template has matching slots and skeleton", () => {
    const item = library.get("invariant-check");
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
    const item = library.get("invariant-check");
    expect(item).not.toBeNull();
    expect(item!.template.normalizations.length).toBeGreaterThan(0);
  });

  describe("dogfood: solver verification", () => {
    it("detects invariant violation (SAT = bug exists)", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
; Precondition: x >= 0
(declare-const x Int)
(declare-const result Int)

; Function: result = x * x + 1
(assert (= result (+ (* x x) 1)))

; Postcondition: result > x (should hold for all x >= 0)
; We negate it: is there an x >= 0 where result <= x?
(assert (>= x 0))
(assert (not (> result x)))
`,
        });
        expect(result.status).toBe("unsat");
      } finally {
        solver.dispose();
      }
    });

    it("finds counterexample when invariant is violated (SAT)", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
; Precondition: x is any integer
(declare-const x Int)
(declare-const result Int)

; Function: result = x - 1
(assert (= result (- x 1)))

; Postcondition: result > 0 (does NOT hold for x <= 1)
; Negate: is there any x where result <= 0?
(assert (not (> result 0)))
`,
        });
        expect(result.status).toBe("sat");
        if (result.status === "sat") {
          const x = parseInt(result.model.x, 10);
          expect(x).toBeLessThanOrEqual(1);
        }
      } finally {
        solver.dispose();
      }
    });

    it("verifies array index invariant (no out-of-bounds)", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-const idx Int)
(declare-const len Int)

; Precondition: 0 <= idx < len, len > 0
(assert (>= idx 0))
(assert (< idx len))
(assert (> len 0))

; Invariant: accessing arr[idx] with length len is safe
; Negate: is there an idx that is out of bounds despite the checks?
(assert (or (>= idx len) (< idx 0)))
`,
        });
        expect(result.status).toBe("unsat");
      } finally {
        solver.dispose();
      }
    });
  });
});
