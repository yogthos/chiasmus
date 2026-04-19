import { describe, it, expect } from "vitest";
import { graphToProlog } from "../../src/graph/facts.js";
import type { CodeGraph, CallsFact } from "../../src/graph/types.js";

const emptyGraph = (calls: CallsFact[]): CodeGraph => ({
  defines: [],
  calls,
  imports: [],
  exports: [],
  contains: [],
});

describe("CallsFact.calleeQN (R2)", () => {
  it("emits calls_qn/3 when calleeQN is present", () => {
    const graph = emptyGraph([
      { caller: "foo", callee: "bar", calleeQN: "src/mod.ts:Bar.bar" },
    ]);
    const program = graphToProlog(graph);
    // Plain calls/2 is preserved for back-compat
    expect(program).toMatch(/calls\(foo,\s*bar\)\./);
    // calls_qn/3 is emitted alongside
    expect(program).toMatch(/calls_qn\(foo,\s*bar,\s*'src\/mod\.ts:Bar\.bar'\)\./);
    // dynamic declaration is present
    expect(program).toMatch(/:-\s*dynamic\(calls_qn\/3\)\./);
  });

  it("does not emit calls_qn when calleeQN is missing", () => {
    const graph = emptyGraph([{ caller: "foo", callee: "bar" }]);
    const program = graphToProlog(graph);
    expect(program).toMatch(/calls\(foo,\s*bar\)\./);
    expect(program).not.toMatch(/calls_qn\(/);
  });

  it("mixed: only rows with calleeQN produce calls_qn facts", () => {
    const graph = emptyGraph([
      { caller: "a", callee: "b" },
      { caller: "a", callee: "c", calleeQN: "src/x.ts:C.c" },
    ]);
    const program = graphToProlog(graph);
    expect(program).toMatch(/calls\(a,\s*b\)\./);
    expect(program).toMatch(/calls\(a,\s*c\)\./);
    expect(program).toMatch(/calls_qn\(a,\s*c,\s*'src\/x\.ts:C\.c'\)\./);
    // No calls_qn for `b` because it has no QN
    expect(program).not.toMatch(/calls_qn\(a,\s*b/);
  });

  it("the QN atom is Prolog-escaped correctly", () => {
    const graph = emptyGraph([
      { caller: "a", callee: "b", calleeQN: "path with 'quote'.ts:B.b" },
    ]);
    const program = graphToProlog(graph);
    // single quotes inside the atom should be backslash-escaped
    expect(program).toContain(
      `calls_qn(a, b, 'path with \\'quote\\'.ts:B.b').`,
    );
  });

  it("does not emit calls_qn dynamic declaration when no rows have QN", () => {
    const graph = emptyGraph([{ caller: "x", callee: "y" }]);
    const program = graphToProlog(graph);
    expect(program).not.toMatch(/:-\s*dynamic\(calls_qn\/3\)\./);
  });
});

describe("ImportsFact.resolved → imports_resolved/3 Prolog facts", () => {
  it("emits imports_resolved/3 when resolved is present", () => {
    const graph: CodeGraph = {
      defines: [],
      calls: [],
      imports: [
        { file: "a.ts", name: "X", source: "./x.js", resolved: "src/x.ts" },
      ],
      exports: [],
      contains: [],
    };
    const prolog = graphToProlog(graph);
    // Back-compat: imports/3 still emitted.
    expect(prolog).toMatch(/imports\('a\.ts',\s*'X',\s*'\.\/x\.js'\)\./);
    // New additive fact.
    expect(prolog).toMatch(
      /imports_resolved\('a\.ts',\s*'X',\s*'src\/x\.ts'\)\./,
    );
    expect(prolog).toMatch(/:-\s*dynamic\(imports_resolved\/3\)\./);
  });

  it("does not emit imports_resolved when no row has resolved", () => {
    const graph: CodeGraph = {
      defines: [],
      calls: [],
      imports: [{ file: "a.ts", name: "X", source: "lodash" }],
      exports: [],
      contains: [],
    };
    const prolog = graphToProlog(graph);
    expect(prolog).not.toMatch(/imports_resolved\(/);
  });
});
