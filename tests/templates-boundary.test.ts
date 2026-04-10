import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("boundary-condition template", () => {
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

  it("is found by search for boundary edge case check", () => {
    const results = library.search(
      "check boundary conditions and edge cases for off-by-one or overflow bugs"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("boundary-condition");
  });

  it("is found by search for integer overflow underflow", () => {
    const results = library.search(
      "verify integer arithmetic for overflow underflow at boundary values"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("boundary-condition");
  });

  it("template has matching slots and skeleton", () => {
    const item = library.get("boundary-condition");
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
    const item = library.get("boundary-condition");
    expect(item).not.toBeNull();
    expect(item!.template.normalizations.length).toBeGreaterThan(0);
  });

  describe("dogfood: solver verification", () => {
    it("finds off-by-one error at array boundary", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-const i Int)
(declare-const len Int)

; Domain: 0 <= len, i is an index into an array of length len
(assert (>= len 0))

; Loop condition: i < len
; After loop: i >= len (loop terminated)
(assert (>= i len))

; Bug: code accesses arr[i] after the loop assuming i < len
; Check: can i equal len at this point?
(assert (= i len))
(assert (> len 0))

; This is satisfiable: off-by-one — i == len is a valid post-loop value
`,
        });
        expect(result.status).toBe("sat");
        if (result.status === "sat") {
          expect(parseInt(result.model.i, 10)).toBe(parseInt(result.model.len, 10));
        }
      } finally {
        solver.dispose();
      }
    });

    it("proves no overflow within safe range", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-const a Int)
(declare-const b Int)
(declare-const sum Int)

; Inputs constrained to safe range
(assert (>= a 0))
(assert (<= a 1000))
(assert (>= b 0))
(assert (<= b 1000))

; sum = a + b
(assert (= sum (+ a b)))

; Check: can sum exceed 2000? (max safe value)
(assert (> sum 2000))
`,
        });
        expect(result.status).toBe("unsat");
      } finally {
        solver.dispose();
      }
    });

    it("finds underflow when subtracting unsigned values", async () => {
      const solver = await createZ3Solver();
      try {
        const result = await solver.solve({
          type: "z3",
          smtlib: `
(declare-const a Int)
(declare-const b Int)
(declare-const result Int)

; Unsigned-like: both non-negative
(assert (>= a 0))
(assert (>= b 0))

; result = a - b (may underflow if b > a)
(assert (= result (- a b)))

; Check: can result be negative?
(assert (< result 0))
`,
        });
        expect(result.status).toBe("sat");
        if (result.status === "sat") {
          const a = parseInt(result.model.a, 10);
          const b = parseInt(result.model.b, 10);
          expect(b).toBeGreaterThan(a);
        }
      } finally {
        solver.dispose();
      }
    });
  });
});
