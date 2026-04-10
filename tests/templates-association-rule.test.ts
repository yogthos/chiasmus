import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { createPrologSolver } from "../src/solvers/prolog-solver.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("association-rule-check template", () => {
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

  it("is found by search for code pattern co-occurrence check", () => {
    const results = library.search(
      "check if code patterns that should co-occur are both present or both absent"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("association-rule-check");
  });

  it("is found by search for lock unlock pairing", () => {
    const results = library.search(
      "verify that lock and unlock calls are always paired together"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("association-rule-check");
  });

  it("template has matching slots and skeleton", () => {
    const item = library.get("association-rule-check");
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
    const item = library.get("association-rule-check");
    expect(item).not.toBeNull();
    expect(item!.template.normalizations.length).toBeGreaterThan(0);
  });

  describe("dogfood: solver verification", () => {
    it("detects missing paired call (lock without unlock)", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
calls(handler, lock).
calls(handler, read_data).
calls(cleanup, unlock).
calls(other, lock).

paired(A, B) :- calls(F, A), calls(F, B), A \\= B.

missing_pair(Func, Missing) :-
  calls(Func, lock),
  \\+ calls(Func, unlock),
  Missing = unlock.
`,
          query: "missing_pair(Func, Missing).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const pairs = result.answers.map((a) => ({
            func: a.bindings.Func,
            missing: a.bindings.Missing,
          }));
          expect(pairs.length).toBeGreaterThan(0);
          const handlerMissing = pairs.find((p) => p.func === "handler");
          expect(handlerMissing).toBeDefined();
        }
      } finally {
        solver.dispose();
      }
    });

    it("finds functions that follow required co-occurrence pattern", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
calls(init_db, connect).
calls(init_db, set_timeout).
calls(do_query, connect).
calls(do_query, execute).

requires_pair(connect, disconnect).
requires_pair(allocate, free).

good_pairing(Func) :-
  calls(Func, A),
  calls(Func, B),
  requires_pair(A, B).
`,
          query: "good_pairing(Func).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          expect(result.answers.length).toBe(0);
        }
      } finally {
        solver.dispose();
      }
    });

    it("detects required setup/teardown co-occurrence", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
calls(setup_test, create_fixture).
calls(setup_test, run_test).
calls(setup_test, cleanup).
calls(bad_test, create_fixture).
calls(bad_test, run_test).

compliant(Func) :-
  calls(Func, create_fixture),
  calls(Func, cleanup).

noncompliant(Func) :-
  calls(Func, create_fixture),
  \\+ calls(Func, cleanup).
`,
          query: "noncompliant(Func).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const funcs = result.answers.map((a) => a.bindings.Func);
          expect(funcs).toContain("bad_test");
          expect(funcs).not.toContain("setup_test");
        }
      } finally {
        solver.dispose();
      }
    });
  });
});
