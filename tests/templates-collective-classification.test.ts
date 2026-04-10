import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { createPrologSolver } from "../src/solvers/prolog-solver.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("collective-classification template", () => {
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

  it("is found by search for propagating labels through call graph", () => {
    const results = library.search(
      "propagate security sensitivity labels through the call graph from known functions"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("collective-classification");
  });

  it("is found by search for classifying functions by neighbors", () => {
    const results = library.search(
      "classify functions based on what they call and what calls them"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("collective-classification");
  });

  it("template has matching slots and skeleton", () => {
    const item = library.get("collective-classification");
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
    const item = library.get("collective-classification");
    expect(item).not.toBeNull();
    expect(item!.template.normalizations.length).toBeGreaterThan(0);
  });

  describe("dogfood: solver verification", () => {
    it("propagates security-sensitive label through call graph", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
calls(handle_login, hash_password).
calls(handle_login, create_session).
calls(hash_password, crypto_lib).
calls(create_session, generate_token).

sensitive(hash_password).
sensitive(crypto_lib).

sensitive_prop(Func) :- sensitive(Func).
sensitive_prop(Func) :- calls(Func, Callee), sensitive_prop(Callee).
`,
          query: "sensitive_prop(X).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const sensitive = result.answers.map((a) => a.bindings.X);
          expect(sensitive).toContain("hash_password");
          expect(sensitive).toContain("crypto_lib");
          expect(sensitive).toContain("handle_login");
        }
      } finally {
        solver.dispose();
      }
    });

    it("classifies functions as data-handling based on neighbors", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
calls(process_payment, validate_card).
calls(process_payment, charge_card).
calls(charge_card, payment_gateway).
calls(format_response, json_encode).
calls(format_response, set_headers).

handles_data(payment_gateway).
handles_data(json_encode).

handles_data_prop(Func) :- handles_data(Func).
handles_data_prop(Func) :- calls(Func, Callee), handles_data_prop(Callee).

data_sensitive(Func) :- handles_data_prop(Func), \\+ handles_data(Func).
`,
          query: "data_sensitive(Func).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const classified = result.answers.map((a) => a.bindings.Func);
          expect(classified).toContain("charge_card");
          expect(classified).toContain("process_payment");
          expect(classified).toContain("format_response");
        }
      } finally {
        solver.dispose();
      }
    });

    it("finds functions that need error handling based on callee properties", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
calls(main, handler).
calls(handler, db_query).
calls(handler, validate).
calls(validate, parse_input).

can_fail(db_query).
can_fail(parse_input).

calls_failing(Func) :- can_fail(Func).
calls_failing(Func) :- calls(Func, Callee), calls_failing(Callee).

needs_error_handling(Func) :- calls_failing(Func), \\+ calls(Func, catch_error).
`,
          query: "needs_error_handling(Func).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const funcs = result.answers.map((a) => a.bindings.Func);
          expect(funcs).toContain("main");
          expect(funcs).toContain("handler");
          expect(funcs).toContain("validate");
        }
      } finally {
        solver.dispose();
      }
    });
  });
});
