import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import { getLanguageForFile, getSupportedExtensions, parseSourceAsync } from "../../src/graph/parser.js";
import { callers } from "../../src/graph/native-analyses.js";

async function defs(content: string, path = "app.lisp") {
  return extractGraph([{ path, content }]);
}

describe("Common Lisp support", () => {
  describe("parser", () => {
    it("maps Lisp extensions to commonlisp", () => {
      expect(getLanguageForFile("app.lisp")).toBe("commonlisp");
      expect(getLanguageForFile("app.lsp")).toBe("commonlisp");
      expect(getLanguageForFile("app.cl")).toBe("commonlisp");
      expect(getLanguageForFile("my-system.asd")).toBe("commonlisp");
    });

    it("lists the new extensions as supported", () => {
      expect(getSupportedExtensions()).toContain(".lisp");
    });

    it("parses Common Lisp source via WASM", async () => {
      const tree = await parseSourceAsync("(defun hello (x) (1+ x))", "test.lisp");
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("source");
    });
  });

  describe("defines", () => {
    it("extracts the defun family as functions", async () => {
      const g = await defs(`
(defun run (x) x)
(defmacro with-thing (b &body body) \`(let ,b ,@body))
(defgeneric area (shape))
`);
      const fns = g.defines.filter((d) => d.kind === "function").map((d) => d.name);
      expect(fns).toContain("run");
      expect(fns).toContain("with-thing");
      expect(fns).toContain("area");
    });

    it("captures the lambda list as the signature", async () => {
      const g = await defs(`(defun add (a b) (+ a b))\n(defun nullary () 1)`);
      expect(g.defines.find((d) => d.name === "add")?.signature).toBe("(a b)");
      expect(g.defines.find((d) => d.name === "nullary")?.signature).toBe("()");
    });

    it("extracts defvar / defparameter / defconstant as variables", async () => {
      const g = await defs(`(defvar *state* nil)\n(defparameter *limit* 10)\n(defconstant +pi+ 3)`);
      const vars = g.defines.filter((d) => d.kind === "variable").map((d) => d.name);
      expect(vars).toContain("*state*");
      expect(vars).toContain("*limit*");
      expect(vars).toContain("+pi+");
    });

    it("extracts defclass / defstruct / define-condition as classes", async () => {
      const g = await defs(`
(defclass point () ((x :initarg :x)))
(defstruct pt x y)
(define-condition oops (error) ())
`);
      const classes = g.defines.filter((d) => d.kind === "class").map((d) => d.name);
      expect(classes).toContain("point");
      expect(classes).toContain("pt");
      expect(classes).toContain("oops");
    });

    it("does not define anything for defmethod", async () => {
      const g = await defs(`(defgeneric area (s))\n(defmethod area ((s point)) 1)`);
      expect(g.defines.filter((d) => d.name === "area")).toHaveLength(1);
    });

    it("skips (defun (setf place) ...) rather than inventing a name", async () => {
      const g = await defs(`(defun (setf thing) (v obj) v)\n(defun plain (x) x)`);
      expect(g.defines.map((d) => d.name)).toEqual(["plain"]);
    });

    it("records the definition line", async () => {
      const g = await defs(`(defun a () 1)\n(defun b () 2)\n`);
      expect(g.defines.find((d) => d.name === "a")?.line).toBe(1);
      expect(g.defines.find((d) => d.name === "b")?.line).toBe(2);
    });
  });

  describe("packages", () => {
    it("qualifies defines with the in-package package", async () => {
      const g = await defs(`(in-package #:my.app)\n(defun run (x) x)`);
      expect(g.defines.map((d) => d.name)).toContain("my.app:run");
    });

    it("accepts :kw, #:kw and string package designators", async () => {
      const a = await defs(`(in-package :one)\n(defun f () 1)`, "a.lisp");
      const b = await defs(`(in-package #:two)\n(defun f () 1)`, "b.lisp");
      const c = await defs(`(in-package "THREE")\n(defun f () 1)`, "c.lisp");
      expect(a.defines[0].name).toBe("one:f");
      expect(b.defines[0].name).toBe("two:f");
      expect(c.defines[0].name).toBe("THREE:f");
    });

    it("leaves names bare when the file has no in-package form", async () => {
      const g = await defs(`(defun run (x) x)`);
      expect(g.defines.map((d) => d.name)).toEqual(["run"]);
    });

    it("qualifies call edges consistently with defines", async () => {
      const g = await defs(`
(in-package #:my.app)
(defun caller (x) (callee x))
(defun callee (x) x)
`);
      expect(g.calls).toContainEqual({ caller: "my.app:caller", callee: "my.app:callee" });
    });

    it("leaves calls to names not defined in the file unqualified", async () => {
      // `subseq` lives in COMMON-LISP, not in whatever package this file sets;
      // stamping the current package on it would invent a node per package.
      const g = await defs(`(in-package #:my.app)\n(defun run (s) (subseq s 1))`);
      const callees = g.calls.map((c) => c.callee);
      expect(callees).toContain("subseq");
      expect(callees).not.toContain("my.app:subseq");
    });

    it("normalizes an explicit pkg::name reference to pkg:name", async () => {
      const g = await defs(`(defun run () (other::helper 1))`);
      expect(g.calls).toContainEqual({ caller: "run", callee: "other:helper" });
    });

    it("records defpackage :use entries as imports", async () => {
      const g = await defs(`
(defpackage #:my.app
  (:use #:cl #:alexandria)
  (:export #:run))
(in-package #:my.app)
(defun run () 1)
`);
      const names = g.imports.map((i) => i.name);
      expect(names).toContain("cl");
      expect(names).toContain("alexandria");
    });

    it("honours a defpackage :export list", async () => {
      const g = await defs(`
(defpackage #:my.app (:use #:cl) (:export #:run))
(in-package #:my.app)
(defun run () (internal))
(defun internal () 1)
`);
      expect(g.exports.map((e) => e.name)).toEqual(["my.app:run"]);
    });

    it("exports every defun when no defpackage :export list exists", async () => {
      const g = await defs(`(defun a () 1)\n(defun b () 2)\n(defvar *v* 1)`);
      expect(g.exports.map((e) => e.name).sort()).toEqual(["a", "b"]);
    });
  });

  describe("calls", () => {
    it("extracts call edges between defuns", async () => {
      const g = await defs(`(defun a () (b))\n(defun b () (c))\n(defun c () 1)`);
      expect(g.calls).toContainEqual({ caller: "a", callee: "b" });
      expect(g.calls).toContainEqual({ caller: "b", callee: "c" });
    });

    it("attributes a defmethod body to the generic function", async () => {
      const g = await defs(`
(defgeneric area (s))
(defmethod area ((s point)) (compute-area s))
(defun compute-area (s) s)
`);
      expect(g.calls).toContainEqual({ caller: "area", callee: "compute-area" });
    });

    it("filters special forms and core macros out of the call graph", async () => {
      const g = await defs(`
(defun f (x)
  (let ((y 1))
    (when (and x y)
      (loop for i from 1 to 3 do (progn i)))))
`);
      const callees = g.calls.filter((c) => c.caller === "f").map((c) => c.callee);
      for (const sf of ["let", "when", "and", "progn", "loop", "defun", "setq", "if"]) {
        expect(callees).not.toContain(sf);
      }
    });

    it("emits an edge for a #'function reference passed to a HOF", async () => {
      const g = await defs(`
(defun double (x) (* x 2))
(defun run (xs) (mapcar #'double xs))
`);
      expect(g.calls).toContainEqual({ caller: "run", callee: "double" });
      expect(g.calls.map((c) => c.callee)).not.toContain("xs");
    });

    it("emits an edge for an in-file define referenced as a value", async () => {
      const g = await defs(`(defun handler (r) r)\n(defvar *routes* (list #'handler))`);
      expect(g.calls).toContainEqual({ caller: "*routes*", callee: "handler" });
    });

    it("attributes top-level side-effecting forms to a file-level caller", async () => {
      const g = await defs(`(defun setup () 1)\n(setup)`, "boot.lisp");
      expect(g.calls).toContainEqual({ caller: "<toplevel:boot.lisp>", callee: "setup" });
    });

    it("does not emit edges to locally bound names", async () => {
      const g = await defs(`
(defun f (x)
  (let ((y 1) (g #'identity))
    (labels ((h (a) (list a y)))
      (h (funcall g x)))))
`);
      const callees = g.calls.map((c) => c.callee);
      for (const local of ["y", "g", "h", "x", "a"]) {
        expect(callees).not.toContain(local);
      }
    });

    it("does not emit edges to lambda-list parameters", async () => {
      const g = await defs(`(defun run (proc xs) (funcall proc xs))`);
      const callees = g.calls.map((c) => c.callee);
      expect(callees).not.toContain("proc");
      expect(callees).not.toContain("xs");
    });

    it("does not emit edges to destructuring and iteration variables", async () => {
      const g = await defs(`
(defun f (pairs)
  (dolist (p pairs)
    (multiple-value-bind (q r) (floor 7 2)
      (list p q r))))
`);
      const callees = g.calls.map((c) => c.callee);
      for (const local of ["p", "q", "r", "pairs"]) {
        expect(callees).not.toContain(local);
      }
    });

    it("lets a local binding shadow a top-level definition", async () => {
      const g = await defs(`
(defun helper (x) x)
(defun run (v)
  (let ((helper 1))
    (list helper v)))
`);
      expect(g.calls).not.toContainEqual({ caller: "run", callee: "helper" });
    });

    it("looks inside backquote for call sites", async () => {
      const g = await defs(`
(defun helper () 1)
(defmacro build () \`(list ,(helper)))
`);
      expect(g.calls).toContainEqual({ caller: "build", callee: "helper" });
    });

    it("does not emit self-edges", async () => {
      const g = await defs(`(defun fact (n) (if (= n 0) 1 (fact (- n 1))))`);
      expect(g.calls.some((c) => c.caller === c.callee)).toBe(false);
    });
  });

  describe("cross-file resolution", () => {
    it("connects a bare call to the same package in another file", async () => {
      // A CL package spans files, and calls inside it are written bare, so
      // this only resolves once every file's defines are known.
      const g = await extractGraph([
        { path: "a.lisp", content: `(in-package #:app)\n(defun start () (bootstrap))` },
        { path: "b.lisp", content: `(in-package #:app)\n(defun bootstrap () 1)` },
      ]);
      expect(g.calls).toContainEqual({ caller: "app:start", callee: "app:bootstrap" });
    });

    it("resolves a bare call made from a top-level form", async () => {
      const g = await extractGraph([
        { path: "a.lisp", content: `(in-package #:app)\n(bootstrap)` },
        { path: "b.lisp", content: `(in-package #:app)\n(defun bootstrap () 1)` },
      ]);
      expect(g.calls).toContainEqual({ caller: "<toplevel:a.lisp>", callee: "app:bootstrap" });
    });

    it("does not connect files in different packages", async () => {
      const g = await extractGraph([
        { path: "a.lisp", content: `(in-package #:one)\n(defun start () (bootstrap))` },
        { path: "b.lisp", content: `(in-package #:two)\n(defun bootstrap () 1)` },
      ]);
      expect(g.calls).toContainEqual({ caller: "one:start", callee: "bootstrap" });
      expect(g.calls).not.toContainEqual({ caller: "one:start", callee: "two:bootstrap" });
    });

    it("leaves other languages' call edges alone", async () => {
      const g = await extractGraph([
        { path: "a.lisp", content: `(in-package #:app)\n(defun start () (helper))` },
        { path: "core.clj", content: `(ns my.ns)\n(defn helper [] 1)` },
      ]);
      expect(g.calls).toContainEqual({ caller: "app:start", callee: "helper" });
    });
  });

  describe("analysis integration", () => {
    it("resolves a bare target name to its package-qualified node", async () => {
      const g = await defs(`
(in-package #:my.app)
(defun caller () (callee))
(defun callee () 1)
`);
      expect(callers(g, "callee")).toContain("my.app:caller");
    });
  });

  describe("file node", () => {
    it("records the language and a ;;;-style file doc", async () => {
      const g = await extractGraph([{
        path: "app.lisp",
        content: `;;;; Entry points for the app.\n(defun go () 1)\n`,
      }]);
      const f = g.files?.find((x) => x.path === "app.lisp");
      expect(f?.language).toBe("commonlisp");
      expect(f?.fileDoc).toBe("Entry points for the app.");
    });
  });
});
