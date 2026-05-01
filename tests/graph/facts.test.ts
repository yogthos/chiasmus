import { describe, it, expect } from "vitest";
import { graphToProlog, escapeAtom } from "../../src/graph/facts.js";
import { extractGraph } from "../../src/graph/extractor.js";
import { createPrologSolver } from "../../src/solvers/prolog-solver.js";
import type { CodeGraph } from "../../src/graph/types.js";

describe("escapeAtom", () => {
  it("leaves simple atoms unquoted", () => {
    expect(escapeAtom("hello")).toBe("hello");
    expect(escapeAtom("foo_bar")).toBe("foo_bar");
  });

  it("quotes atoms with special characters", () => {
    expect(escapeAtom("src/server.ts")).toBe("'src/server.ts'");
    expect(escapeAtom("my-func")).toBe("'my-func'");
    expect(escapeAtom("MyClass")).toBe("'MyClass'");
  });

  it("escapes internal single quotes", () => {
    expect(escapeAtom("it's")).toBe("'it\\'s'");
  });

  it("escapes backslashes so trailing backslash cannot terminate the quote", async () => {
    // A function name ending with a backslash must not corrupt the Prolog atom.
    const escaped = escapeAtom("foo\\");
    // Must be parseable by SWI-Prolog as a single atom.
    const program = `defines('test.ts', ${escaped}, function, 1).`;
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "defines(_, X, _, _).",
    });
    solver.dispose();
    expect(result.status).toBe("success");
  });

  it("escapes control characters (newline, tab, carriage return)", async () => {
    // Tree-sitter can extract text containing control chars for unusual source.
    const ugly = "foo\nbar\tbaz\rqux";
    const escaped = escapeAtom(ugly);
    const program = `defines('test.ts', ${escaped}, function, 1).`;
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "defines(_, X, _, _).",
    });
    solver.dispose();
    expect(result.status).toBe("success");
  });

  it("round-trips an atom containing a literal backslash", async () => {
    const program = `calls(${escapeAtom("a\\b")}, ${escapeAtom("c")}).`;
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "calls(_, c).",
    });
    solver.dispose();
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers.length).toBeGreaterThan(0);
    }
  });
});

describe("graphToProlog", () => {
  it("generates syntactically valid Prolog accepted by solver", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function a() { b(); }
        function b() { c(); }
        function c() {}
        export function a() {}
      `,
    }]);

    const program = graphToProlog(graph);
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "defines(_, Name, function, _).",
    });
    solver.dispose();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const names = result.answers.map((a) => a.bindings.Name);
      expect(names).toContain("a");
      expect(names).toContain("b");
      expect(names).toContain("c");
    }
  });

  it("produces queryable call facts", async () => {
    const graph: CodeGraph = {
      defines: [
        { file: "test.ts", name: "a", kind: "function", line: 1 },
        { file: "test.ts", name: "b", kind: "function", line: 2 },
      ],
      calls: [{ caller: "a", callee: "b" }],
      imports: [],
      exports: [],
      contains: [],
    };

    const program = graphToProlog(graph);
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "calls(a, X).",
    });
    solver.dispose();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers[0].bindings.X).toBe("b");
    }
  });

  it("handles file paths with slashes in atoms", async () => {
    const graph: CodeGraph = {
      defines: [{ file: "src/server.ts", name: "main", kind: "function", line: 1 }],
      calls: [],
      imports: [],
      exports: [],
      contains: [],
    };

    const program = graphToProlog(graph);
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "defines(File, main, function, _).",
    });
    solver.dispose();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers[0].bindings.File).toMatch(/server/);
    }
  });

  it("auto-detects entry points from exports", async () => {
    const graph: CodeGraph = {
      defines: [
        { file: "test.ts", name: "main", kind: "function", line: 1 },
        { file: "test.ts", name: "helper", kind: "function", line: 5 },
      ],
      calls: [],
      imports: [],
      exports: [{ file: "test.ts", name: "main" }],
      contains: [],
    };

    const program = graphToProlog(graph);
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "entry_point(X).",
    });
    solver.dispose();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0].bindings.X).toBe("main");
    }
  });

  it("cycle-safe reachability works for transitive calls", async () => {
    const graph: CodeGraph = {
      defines: [
        { file: "t.ts", name: "a", kind: "function", line: 1 },
        { file: "t.ts", name: "b", kind: "function", line: 2 },
        { file: "t.ts", name: "c", kind: "function", line: 3 },
      ],
      calls: [
        { caller: "a", callee: "b" },
        { caller: "b", callee: "c" },
      ],
      imports: [],
      exports: [],
      contains: [],
    };

    const program = graphToProlog(graph);
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "reaches(a, c).",
    });
    solver.dispose();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.answers.length).toBeGreaterThan(0);
    }
  });

  it("dead code detection finds unreachable functions", async () => {
    const graph: CodeGraph = {
      defines: [
        { file: "t.ts", name: "main", kind: "function", line: 1 },
        { file: "t.ts", name: "used", kind: "function", line: 5 },
        { file: "t.ts", name: "unused", kind: "function", line: 10 },
      ],
      calls: [{ caller: "main", callee: "used" }],
      imports: [],
      exports: [{ file: "t.ts", name: "main" }],
      contains: [],
    };

    const program = graphToProlog(graph);
    const solver = createPrologSolver();
    const result = await solver.solve({
      type: "prolog",
      program,
      query: "dead(X).",
    });
    solver.dispose();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const deadNames = result.answers.map((a) => a.bindings.X);
      expect(deadNames).toContain("unused");
      expect(deadNames).not.toContain("main");
      expect(deadNames).not.toContain("used");
    }
  });
});
