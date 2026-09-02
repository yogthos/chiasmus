import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import { getLanguageForFile, getSupportedExtensions, parseSourceAsync } from "../../src/graph/parser.js";

/** Names defined in the first (only) file of a single-file extraction. */
async function defs(content: string, path = "core.scm") {
  const graph = await extractGraph([{ path, content }]);
  return graph;
}

describe("Scheme support", () => {
  describe("parser", () => {
    it("maps Scheme extensions to scheme", () => {
      expect(getLanguageForFile("core.scm")).toBe("scheme");
      expect(getLanguageForFile("core.ss")).toBe("scheme");
      expect(getLanguageForFile("lib.sld")).toBe("scheme");
      expect(getLanguageForFile("lib.sls")).toBe("scheme");
      expect(getLanguageForFile("prog.sps")).toBe("scheme");
    });

    it("maps .rkt to racket", () => {
      expect(getLanguageForFile("main.rkt")).toBe("racket");
    });

    it("lists the new extensions as supported", () => {
      const exts = getSupportedExtensions();
      expect(exts).toContain(".scm");
      expect(exts).toContain(".rkt");
    });

    it("parses Scheme source via WASM", async () => {
      const tree = await parseSourceAsync("(define (hello x) (+ x 1))", "test.scm");
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("program");
    });

    it("parses Racket source with the Scheme grammar", async () => {
      const tree = await parseSourceAsync("#lang racket/base\n(define x 1)", "test.rkt");
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("program");
    });
  });

  describe("defines", () => {
    it("extracts (define (name args) body) as a function", async () => {
      const g = await defs(`
(define (handle-request req)
  (process req))

(define (validate data)
  (check data))
`);
      const fns = g.defines.filter((d) => d.kind === "function").map((d) => d.name);
      expect(fns).toContain("handle-request");
      expect(fns).toContain("validate");
    });

    it("captures the arglist as the signature", async () => {
      const g = await defs(`(define (add a b) (+ a b))\n(define (noargs) 1)`);
      expect(g.defines.find((d) => d.name === "add")?.signature).toBe("(a b)");
      expect(g.defines.find((d) => d.name === "noargs")?.signature).toBe("()");
    });

    it("treats (define name (lambda ...)) as a function with the lambda arglist", async () => {
      const g = await defs(`(define greet (lambda (who) (display who)))`);
      const d = g.defines.find((x) => x.name === "greet");
      expect(d?.kind).toBe("function");
      expect(d?.signature).toBe("(who)");
    });

    it("treats (define name value) as a variable", async () => {
      const g = await defs(`(define limit 42)`);
      expect(g.defines.find((d) => d.name === "limit")?.kind).toBe("variable");
    });

    it("extracts define-values bindings as variables", async () => {
      const g = await defs(`(define-values (q r) (floor/ 7 2))`);
      const names = g.defines.map((d) => d.name);
      expect(names).toContain("q");
      expect(names).toContain("r");
    });

    it("extracts macro definitions", async () => {
      const g = await defs(`
(define-syntax swap!
  (syntax-rules () ((_ a b) (let ((tmp a)) tmp))))
(define-syntax-rule (unless c body) (if c #f body))
`);
      const names = g.defines.map((d) => d.name);
      expect(names).toContain("swap!");
      expect(names).toContain("unless");
    });

    it("extracts define-record-type as a class plus its accessors", async () => {
      const g = await defs(`
(define-record-type point
  (make-point x y)
  point?
  (x point-x set-point-x!)
  (y point-y))
`);
      expect(g.defines.find((d) => d.name === "point")?.kind).toBe("class");
      const fns = g.defines.filter((d) => d.kind === "function").map((d) => d.name);
      expect(fns).toContain("make-point");
      expect(fns).toContain("point?");
      expect(fns).toContain("point-x");
      expect(fns).toContain("set-point-x!");
      expect(fns).toContain("point-y");
    });

    it("records the definition line", async () => {
      const g = await defs(`(define (a) 1)\n(define (b) 2)\n`);
      expect(g.defines.find((d) => d.name === "a")?.line).toBe(1);
      expect(g.defines.find((d) => d.name === "b")?.line).toBe(2);
    });

    it("does not register internal defines as top-level definitions", async () => {
      const g = await defs(`
(define (outer x)
  (define (inner y) (* y 2))
  (inner x))
`);
      const names = g.defines.map((d) => d.name);
      expect(names).toContain("outer");
      expect(names).not.toContain("inner");
    });
  });

  describe("Racket and Guile define forms", () => {
    it("extracts define/contract and friends", async () => {
      const g = await defs(
        `
#lang racket/base
(define/contract (helper y) (-> number? number?) (add1 y))
(define/public (pub z) z)
`,
        "main.rkt",
      );
      const names = g.defines.map((d) => d.name);
      expect(names).toContain("helper");
      expect(names).toContain("pub");
    });

    it("extracts struct / define-struct as classes", async () => {
      const g = await defs(`(struct point (x y) #:transparent)\n(define-struct old (a b))`, "main.rkt");
      expect(g.defines.find((d) => d.name === "point")?.kind).toBe("class");
      expect(g.defines.find((d) => d.name === "old")?.kind).toBe("class");
    });

    it("extracts Guile define-public and define*", async () => {
      const g = await defs(`(define-public (go) 1)\n(define* (opt #:optional a) a)`);
      const names = g.defines.map((d) => d.name);
      expect(names).toContain("go");
      expect(names).toContain("opt");
    });
  });

  describe("calls", () => {
    it("extracts call edges between top-level definitions", async () => {
      const g = await defs(`
(define (a) (b))
(define (b) (c))
(define (c) 1)
`);
      expect(g.calls).toContainEqual({ caller: "a", callee: "b" });
      expect(g.calls).toContainEqual({ caller: "b", callee: "c" });
    });

    it("attributes calls inside internal defines to the enclosing top-level fn", async () => {
      const g = await defs(`
(define (outer x)
  (define (inner y) (helper y))
  (inner x))
(define (helper y) y)
`);
      expect(g.calls).toContainEqual({ caller: "outer", callee: "helper" });
    });

    it("filters special forms out of the call graph", async () => {
      const g = await defs(`
(define (f x)
  (let ((y 1))
    (if (and x y) (begin (cond (else 1))) (lambda () 2))))
`);
      const callees = g.calls.filter((c) => c.caller === "f").map((c) => c.callee);
      for (const sf of ["let", "if", "and", "begin", "cond", "else", "lambda", "define"]) {
        expect(callees).not.toContain(sf);
      }
    });

    it("emits an edge for a function passed to a higher-order function", async () => {
      const g = await defs(`
(define (double x) (* x 2))
(define (run xs) (map double xs))
`);
      expect(g.calls).toContainEqual({ caller: "run", callee: "double" });
      // `xs` is a collection argument, not a function reference.
      expect(g.calls.map((c) => c.callee)).not.toContain("xs");
    });

    it("emits an edge for an in-file define referenced as a value", async () => {
      const g = await defs(`
(define (handler req) req)
(define routes (list (cons "/" handler)))
`);
      expect(g.calls).toContainEqual({ caller: "routes", callee: "handler" });
    });

    it("attributes top-level side-effecting forms to a file-level caller", async () => {
      const g = await defs(`
(define (setup) 1)
(setup)
`, "boot.scm");
      expect(g.calls).toContainEqual({ caller: "<toplevel:boot.scm>", callee: "setup" });
    });

    it("does not emit self-edges", async () => {
      const g = await defs(`(define (loop-fn n) (if (= n 0) 0 (loop-fn (- n 1))))`);
      expect(g.calls.some((c) => c.caller === c.callee)).toBe(false);
    });

    it("does not emit edges to locally bound names", async () => {
      const g = await defs(`
(define (walk lst)
  (let loop ((rest lst) (acc '()))
    (if (null? rest) acc (loop (cdr rest) acc))))
(define (apply-to f x)
  (let ((g f)) (g x)))
`);
      const callees = g.calls.map((c) => c.callee);
      // `loop`, `rest`, `acc` and `g` are let bindings, not global procedures.
      for (const local of ["loop", "rest", "acc", "g"]) {
        expect(callees).not.toContain(local);
      }
    });

    it("does not emit edges to lambda parameters", async () => {
      const g = await defs(`(define (run proc xs) (proc xs))`);
      expect(g.calls.map((c) => c.callee)).not.toContain("proc");
    });

    it("does not emit edges to internal define names", async () => {
      const g = await defs(`
(define (outer x)
  (define (inner y) y)
  (inner x))
`);
      expect(g.calls.map((c) => c.callee)).not.toContain("inner");
    });

    it("lets a local binding shadow a top-level definition", async () => {
      const g = await defs(`
(define (helper x) x)
(define (run v)
  (let ((helper (lambda (y) y)))
    (helper v)))
`);
      expect(g.calls).not.toContainEqual({ caller: "run", callee: "helper" });
    });

    it("looks inside quasiquote for call sites", async () => {
      const g = await defs(`
(define (helper) 1)
(define (build) \`(a ,(helper)))
`);
      expect(g.calls).toContainEqual({ caller: "build", callee: "helper" });
    });
  });

  describe("imports", () => {
    it("extracts R7RS (import ...) library names", async () => {
      const g = await defs(`(import (scheme base) (scheme write))`);
      const names = g.imports.map((i) => i.name);
      expect(names).toContain("scheme.base");
      expect(names).toContain("scheme.write");
    });

    it("unwraps only/except/prefix/rename import wrappers", async () => {
      const g = await defs(`(import (only (srfi 1) fold) (prefix (srfi 69) h-))`);
      const names = g.imports.map((i) => i.name);
      expect(names).toContain("srfi.1");
      expect(names).toContain("srfi.69");
    });

    it("extracts Guile use-modules", async () => {
      const g = await defs(`(use-modules (ice-9 match) (srfi srfi-1))`);
      const names = g.imports.map((i) => i.name);
      expect(names).toContain("ice-9.match");
      expect(names).toContain("srfi.srfi-1");
    });

    it("extracts Racket require specs", async () => {
      const g = await defs(`#lang racket\n(require racket/list "helper.rkt" (only-in racket/string string-join))`, "main.rkt");
      const names = g.imports.map((i) => i.name);
      expect(names).toContain("racket/list");
      expect(names).toContain("helper.rkt");
      expect(names).toContain("racket/string");
    });

    it("extracts (load \"file\") as an import", async () => {
      const g = await defs(`(load "other.scm")`);
      expect(g.imports.map((i) => i.source)).toContain("other.scm");
    });

    it("extracts imports declared inside define-library", async () => {
      const g = await defs(`
(define-library (my lib)
  (export go)
  (import (scheme base))
  (begin
    (define (go) 1)))
`, "lib.sld");
      expect(g.imports.map((i) => i.name)).toContain("scheme.base");
      expect(g.defines.map((d) => d.name)).toContain("go");
      expect(g.exports.map((e) => e.name)).toEqual(["go"]);
    });
  });

  describe("exports", () => {
    it("exports every top-level define when the file declares none", async () => {
      const g = await defs(`(define (a) 1)\n(define (b) 2)`);
      const names = g.exports.map((e) => e.name).sort();
      expect(names).toEqual(["a", "b"]);
    });

    it("honours an explicit (provide ...) list", async () => {
      const g = await defs(`#lang racket\n(provide a)\n(define (a) 1)\n(define (b) 2)`, "main.rkt");
      expect(g.exports.map((e) => e.name)).toEqual(["a"]);
    });

    it("honours an explicit (export ...) list", async () => {
      const g = await defs(`(export a)\n(define (a) 1)\n(define (b) 2)`);
      expect(g.exports.map((e) => e.name)).toEqual(["a"]);
    });

    it("honours Guile #:export in define-module", async () => {
      const g = await defs(`
(define-module (my mod)
  #:use-module (ice-9 match)
  #:export (go))
(define (go) 1)
(define (internal) 2)
`);
      expect(g.exports.map((e) => e.name)).toEqual(["go"]);
      expect(g.imports.map((i) => i.name)).toContain("ice-9.match");
    });

    it("uses bare (unqualified) names", async () => {
      const g = await defs(`(define-library (my lib) (begin (define (go) 1)))`, "lib.sld");
      expect(g.defines.map((d) => d.name)).toContain("go");
      expect(g.defines.every((d) => !d.name.includes("/"))).toBe(true);
    });
  });

  describe("file node", () => {
    it("records the language and a ;;;-style file doc", async () => {
      const g = await extractGraph([{
        path: "core.scm",
        content: `;;; Request routing helpers.\n;;; Shared by the server and the CLI.\n(define (go) 1)\n`,
      }]);
      const f = g.files?.find((x) => x.path === "core.scm");
      expect(f?.language).toBe("scheme");
      expect(f?.fileDoc).toBe("Request routing helpers. Shared by the server and the CLI.");
    });

    it("rejects a two-semicolon comment as file doc", async () => {
      const g = await extractGraph([{
        path: "core.scm",
        content: `;; Copyright (c) 2020 Somebody\n(define (go) 1)\n`,
      }]);
      expect(g.files?.find((x) => x.path === "core.scm")?.fileDoc).toBeUndefined();
    });
  });
});
