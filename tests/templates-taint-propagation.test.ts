import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillLibrary } from "../src/skills/library.js";
import { createPrologSolver } from "../src/solvers/prolog-solver.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("taint-propagation template", () => {
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

  it("is found by search for taint analysis data flow", () => {
    const results = library.search(
      "trace tainted data from source to sink and find sanitization gaps"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("taint-propagation");
  });

  it("is found by search for SQL injection path", () => {
    const results = library.search(
      "check if user input can reach a database query without sanitization"
    );
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.template.name);
    expect(names).toContain("taint-propagation");
  });

  it("template has matching slots and skeleton", () => {
    const item = library.get("taint-propagation");
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
    const item = library.get("taint-propagation");
    expect(item).not.toBeNull();
    expect(item!.template.normalizations.length).toBeGreaterThan(0);
  });

  describe("dogfood: solver verification", () => {
    it("finds unsanitized path from source to sink", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
flows(user_input, parse_body).
flows(parse_body, validate).
flows(validate, build_query).
flows(build_query, execute_sql).
flows(user_input, log_request).

taint_source(user_input, user_data).

:- dynamic(sanitize/1).
sanitize(validate).

sink(execute_sql).
sink(log_request).

tainted(X) :- taint_source(X, _).
tainted(Y) :- flows(X, Y), tainted(X), \\+ sanitize(X).
`,
          query: "tainted(X).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const tainted = result.answers.map((a) => a.bindings.X);
          expect(tainted).toContain("user_input");
          expect(tainted).toContain("parse_body");
          expect(tainted).toContain("validate");
          expect(tainted).toContain("log_request");
          expect(tainted).not.toContain("build_query");
          expect(tainted).not.toContain("execute_sql");
        }
      } finally {
        solver.dispose();
      }
    });

    it("finds violation when no sanitizer between source and sink", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
flows(user_input, parse).
flows(parse, query_build).
flows(query_build, execute_sql).

taint_source(user_input, injection).

:- dynamic(sanitize/1).

sink(execute_sql).

tainted(X) :- taint_source(X, _).
tainted(Y) :- flows(X, Y), tainted(X), \\+ sanitize(X).
`,
          query: "tainted(X).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const tainted = result.answers.map((a) => a.bindings.X);
          expect(tainted).toContain("user_input");
          expect(tainted).toContain("parse");
          expect(tainted).toContain("query_build");
          expect(tainted).toContain("execute_sql");
        }
      } finally {
        solver.dispose();
      }
    });

    it("correctly stops taint at sanitizer", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
flows(input, sanitize_html).
flows(sanitize_html, output).
flows(output, response).

taint_source(input, xss).

:- dynamic(sanitize/1).
sanitize(sanitize_html).

sink(response).

tainted(X) :- taint_source(X, _).
tainted(Y) :- flows(X, Y), tainted(X), \\+ sanitize(X).
`,
          query: "tainted(X).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const tainted = result.answers.map((a) => a.bindings.X);
          expect(tainted).toContain("input");
          expect(tainted).toContain("sanitize_html");
          expect(tainted).not.toContain("output");
          expect(tainted).not.toContain("response");
        }
      } finally {
        solver.dispose();
      }
    });

    it("finds multiple independent taint sources", async () => {
      const solver = createPrologSolver();
      try {
        const result = await solver.solve({
          type: "prolog",
          program: `
flows(query_param, route_handler).
flows(route_handler, db_exec).
flows(cookie, session_lookup).
flows(session_lookup, render_page).
flows(render_page, http_response).

taint_source(query_param, injection).
taint_source(cookie, session_hijack).

:- dynamic(sanitize/1).

sink(db_exec).
sink(http_response).

tainted(X) :- taint_source(X, _).
tainted(Y) :- flows(X, Y), tainted(X), \\+ sanitize(X).
`,
          query: "tainted(X).",
        });
        expect(result.status).toBe("success");
        if (result.status === "success") {
          const tainted = result.answers.map((a) => a.bindings.X);
          expect(tainted).toContain("query_param");
          expect(tainted).toContain("cookie");
          expect(tainted).toContain("route_handler");
          expect(tainted).toContain("db_exec");
          expect(tainted).toContain("session_lookup");
          expect(tainted).toContain("render_page");
          expect(tainted).toContain("http_response");
        }
      } finally {
        solver.dispose();
      }
    });
  });
});
