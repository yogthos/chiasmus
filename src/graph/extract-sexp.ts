/**
 * Extraction for the s-expression languages other than Clojure: Scheme
 * (shared with Racket, which reuses the grammar) and Common Lisp.
 *
 * Both walkers follow the same two-phase shape as `walkClojure` in
 * extractor.ts — phase 1 collects top-level definitions, imports and
 * exports; phase 2 walks bodies for call edges, with the names from phase 1
 * available so in-file references resolve. They live here rather than in
 * extractor.ts only because that file is already large.
 *
 * Two rules do most of the work in phase 2, and they're the same for both
 * languages:
 *
 *   1. the head symbol of every evaluated list is a callee, minus a
 *      special-form deny-list;
 *   2. any symbol appearing at any depth that matches a definition in this
 *      file is a reference, which covers `(map double xs)`, `#'handler` in
 *      a table, and every other spot a function is passed as a value.
 *
 * Rule 2 is deliberately restricted to in-file names. Neither language marks
 * function arguments the way Clojure's `#(...)` or a type annotation would,
 * so emitting an edge for every bare symbol argument would bury the graph in
 * locals.
 *
 * Both walkers carry a lexical scope of locally bound names — lambda
 * parameters, `let` and `labels` bindings, internal defines, a named let's
 * loop variable — and neither rule fires for a name in it. Without that,
 * `(let loop ((i 0)) ... (loop ...))` mints a global `loop` node, and since
 * every file writes the same named let, those merge into one fabricated hub
 * that skews `hubs`, `bridges` and the community analyses.
 */

import type { CallsFact, CodeGraph, DefinesFact, ExportsFact, FileNode, ImportsFact } from "./types.js";

/** Emits a call edge, dropping duplicates and self-edges. */
type Emit = (caller: string, callee: string) => void;

function makeEmit(calls: CallsFact[], callSet: Set<string>): Emit {
  return (caller, callee) => {
    if (!caller || !callee || caller === callee) return;
    const key = `${caller}->${callee}`;
    if (callSet.has(key)) return;
    callSet.add(key);
    calls.push({ caller, callee });
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A child scope: the parent's names plus whatever the new binder adds. */
function childScope(parent: Set<string>): Set<string> {
  return new Set(parent);
}

/** Strip the surrounding double quotes from a string literal's raw text. */
function stringValue(node: any): string {
  const t = node.text;
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t;
}

// ── Scheme / Racket ──────────────────────────────────────────────────

/**
 * Node types that carry a form. Everything else a `list` can contain
 * (comments, `#;` datum comments, `#!r6rs` directives) is skipped when
 * counting argument positions.
 */
const SCM_FORM_TYPES = new Set([
  "list", "vector", "byte_vector", "symbol", "string", "number", "boolean",
  "character", "keyword", "quote", "quasiquote", "unquote", "unquote_splicing",
  "syntax", "quasisyntax", "unsyntax", "unsyntax_splicing",
]);

/**
 * Types we descend through hunting for call sites. `quote` is absent on
 * purpose — quoted data isn't code. Quasiquote *is* included: in a macro
 * body its template is the code being generated.
 */
const SCM_RECURSE_TYPES = new Set([
  "list", "vector", "quasiquote", "unquote", "unquote_splicing",
  "syntax", "quasisyntax", "unsyntax", "unsyntax_splicing",
]);

/** Heads that introduce a named definition of the shape `(head (name . args) body)`. */
const SCM_DEFINE_HEADS = new Set([
  "define", "define*", "define-public", "define*-public", "define-private",
  "define/contract", "define/public", "define/private", "define/override",
  "define/augment", "define/public-final", "define/override-final",
  "define-inlinable", "define-integrable", "define-method", "define-once",
]);

/**
 * Definition heads whose subject is always callable, even when written as a
 * bare symbol — `(define-syntax swap! (syntax-rules ...))` defines a macro,
 * not a variable.
 */
const SCM_SYNTAX_DEFINE_HEADS = new Set([
  "define-syntax", "define-syntax-rule", "define-simple-macro", "define-macro",
  "defmacro", "define-syntax-parameter", "define-generic", "define-for-syntax",
]);

/** Heads defining a record/struct type. */
const SCM_STRUCT_HEADS = new Set(["struct", "define-struct", "define-structure", "define-record"]);

/** Lambda heads whose first form is a parameter list, not an expression. */
const SCM_LAMBDA_HEADS = new Set(["lambda", "lambda*", "λ", "named-lambda", "opt-lambda"]);

/**
 * Binding forms: `(head <bindings> body...)` where each binding clause is
 * `(name init...)`. The bound names must not be read as call sites.
 */
const SCM_BINDING_HEADS = new Set([
  "let", "let*", "letrec", "letrec*", "let-values", "let*-values",
  "let-syntax", "letrec-syntax", "fluid-let", "parameterize", "and-let*",
  "let-optionals", "let-keywords", "do",
]);

/**
 * Container forms whose body holds the real top-level forms. The value is
 * how many leading forms to drop — the library name for `define-library`,
 * name plus language for a Racket `module`.
 */
const SCM_CONTAINER_HEADS = new Map<string, number>([
  ["define-library", 1], ["library", 1], ["module", 2], ["module*", 2], ["begin", 0],
]);

/** Import-set wrappers: the library being imported is the next form in. */
const SCM_IMPORT_WRAPPERS = new Set([
  "only", "except", "prefix", "rename", "only-in", "except-in", "prefix-in",
  "rename-in", "for-syntax", "for-template", "for-label", "for-meta",
  "file", "lib", "planet", "quote", "submod",
]);

/**
 * Syntax that occupies head position without being a call. Anything not
 * listed here becomes a callee, so external procedures (`display`, `assoc`)
 * still show up as edges the way they do for the other languages.
 */
const SCM_SPECIAL_FORMS = new Set([
  // Core syntax
  "quote", "quasiquote", "unquote", "unquote-splicing", "syntax", "quasisyntax",
  "unsyntax", "unsyntax-splicing", "if", "cond", "case", "when", "unless",
  "and", "or", "not", "begin", "do", "while", "until", "set!", "else", "=>", "_", "...",
  "delay", "delay-force", "make-promise", "parameterize", "dynamic-wind",
  "guard", "assert", "cond-expand", "include", "include-ci", "case-lambda",
  "syntax-rules", "syntax-case", "with-syntax", "with-handlers", "match",
  "match-lambda", "match-let", "match-define", "receive", "values",
  // Binding + lambda
  ...SCM_BINDING_HEADS, ...SCM_LAMBDA_HEADS,
  // Definition + module syntax
  ...SCM_DEFINE_HEADS, ...SCM_SYNTAX_DEFINE_HEADS, ...SCM_STRUCT_HEADS,
  ...SCM_CONTAINER_HEADS.keys(),
  "define-values", "define-record-type", "define-module", "define-condition-type",
  "import", "export", "export!", "re-export", "provide", "require", "use-modules", "load",
  // Racket comprehensions — the body is walked, the head isn't a procedure
  "for", "for*", "for/list", "for*/list", "for/fold", "for*/fold", "for/vector",
  "for/hash", "for/sum", "for/and", "for/or", "for/first", "for/last",
]);

/** Named children that carry a form, in source order. */
function scmForms(node: any): any[] {
  const out: any[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (SCM_FORM_TYPES.has(c.type)) out.push(c);
  }
  return out;
}

/**
 * Head symbol of a list, or null when the list starts with anything else
 * (`((compose f g) x)`, a `cond` clause, a `let` binding list). A null head
 * means "not a named call site" — the walker still descends into it.
 */
function scmHead(list: any): { name: string; forms: any[] } | null {
  const forms = scmForms(list);
  if (forms.length === 0 || forms[0].type !== "symbol") return null;
  return { name: forms[0].text, forms };
}

/** `(name a b)` → `(a b)`; `(name)` → `()`. */
function scmArglist(header: any): string {
  const rest = scmForms(header).slice(1).map((f) => collapse(f.text));
  return `(${rest.join(" ")})`;
}

/**
 * Name introduced by a define header. `(f x)` → f; `((curried a) b)` → curried
 * (descending the leftmost list); `f` → f. Returns the header list too, when
 * there is one, so the caller can read an arglist off it.
 */
function scmDefineTarget(form: any): { name: string; header: any | null } | null {
  if (form.type === "symbol") return { name: form.text, header: null };
  if (form.type !== "list") return null;
  const header = form;
  let cur: any = form;
  while (cur) {
    const forms = scmForms(cur);
    if (forms.length === 0) return null;
    if (forms[0].type === "symbol") return { name: forms[0].text, header };
    if (forms[0].type !== "list") return null;
    cur = forms[0];
  }
  return null;
}

/** Arglist of a `(lambda (a b) ...)` value form, or undefined if it isn't one. */
function scmLambdaSignature(value: any): string | undefined {
  if (!value || value.type !== "list") return undefined;
  const head = scmHead(value);
  if (!head || !SCM_LAMBDA_HEADS.has(head.name)) return undefined;
  const params = head.forms[1];
  if (!params) return "()";
  return collapse(params.text);
}

/**
 * Add every name a formals list binds. Nested lists contribute all their
 * symbols, which is what `let-values` formals `(a b)` and a `do` clause need.
 */
function scmBindFlat(forms: any[], into: Set<string>): void {
  for (const f of forms) {
    if (f.type === "symbol") into.add(f.text);
    else if (f.type === "list" || f.type === "vector") {
      for (const g of scmForms(f)) if (g.type === "symbol") into.add(g.text);
    }
  }
}

/**
 * Add the names a lambda list binds. A nested list is an optional or keyword
 * argument `(name default)`, so only its first symbol is a binding — the
 * default is an expression that may well contain a real call.
 */
function scmBindParams(form: any, into: Set<string>): void {
  if (!form) return;
  if (form.type === "symbol") { into.add(form.text); return; }
  if (form.type !== "list" && form.type !== "vector") return;
  for (const f of scmForms(form)) {
    if (f.type === "symbol") into.add(f.text);
    else if (f.type === "list") {
      const first = scmForms(f)[0];
      if (first && first.type === "symbol") into.add(first.text);
    }
  }
}

/**
 * Flatten `define-library` / `library` / `module` / `begin` wrappers so their
 * bodies are treated as top-level. The leading library-name and language
 * forms are dropped — they're metadata, not code.
 */
function scmTopLevelForms(root: any): any[] {
  const out: any[] = [];
  const visit = (forms: any[]): void => {
    for (const f of forms) {
      const head = f.type === "list" ? scmHead(f) : null;
      const skip = head ? SCM_CONTAINER_HEADS.get(head.name) : undefined;
      if (head && skip !== undefined) visit(head.forms.slice(1 + skip));
      else out.push(f);
    }
  };
  visit(scmForms(root));
  return out;
}

/**
 * Library name of an import set, dotted: `(scheme base)` → `scheme.base`,
 * `(only (srfi 1) fold)` → `srfi.1`, `racket/list` → `racket/list`,
 * `"helper.rkt"` → `helper.rkt`.
 */
function scmLibraryName(form: any): string | null {
  if (form.type === "symbol") return form.text;
  if (form.type === "string") return stringValue(form);
  if (form.type !== "list") return null;
  const head = scmHead(form);
  if (head && SCM_IMPORT_WRAPPERS.has(head.name)) {
    return head.forms.length > 1 ? scmLibraryName(head.forms[1]) : null;
  }
  const parts = scmForms(form)
    .filter((f) => f.type === "symbol" || f.type === "number")
    .map((f) => f.text);
  return parts.length > 0 ? parts.join(".") : null;
}

export function walkScheme(
  rootNode: any,
  filePath: string,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  callSet: Set<string>,
): void {
  const emit = makeEmit(calls, callSet);
  const topForms = scmTopLevelForms(rootNode);
  const definedNames = new Set<string>();
  const declaredExports: string[] = [];
  let sawExportForm = false;

  const define = (name: string, kind: DefinesFact["kind"], node: any, signature?: string): void => {
    if (definedNames.has(name)) return;
    definedNames.add(name);
    defines.push({ file: filePath, name, kind, line: node.startPosition.row + 1, signature });
  };
  const addImport = (form: any): void => {
    const name = scmLibraryName(form);
    if (name) imports.push({ file: filePath, name, source: name });
  };
  const addExports = (forms: any[]): void => {
    sawExportForm = true;
    for (const f of forms) {
      if (f.type === "symbol") declaredExports.push(f.text);
      // `(rename internal external)` exports under the external name.
      else if (f.type === "list") {
        const inner = scmForms(f).filter((x) => x.type === "symbol");
        if (inner.length > 0) declaredExports.push(inner[inner.length - 1].text);
      }
    }
  };

  // ── Phase 1: definitions, imports, exports ────────────────────────
  for (const form of topForms) {
    if (form.type !== "list") continue;
    const head = scmHead(form);
    if (!head) continue;
    const args = head.forms.slice(1);

    if (SCM_DEFINE_HEADS.has(head.name)) {
      const target = args[0] ? scmDefineTarget(args[0]) : null;
      if (!target) continue;
      if (target.header) {
        define(target.name, "function", form, scmArglist(target.header));
      } else {
        const lambdaSig = scmLambdaSignature(args[1]);
        if (lambdaSig !== undefined) define(target.name, "function", form, lambdaSig);
        else define(target.name, "variable", form);
      }
      continue;
    }

    if (SCM_SYNTAX_DEFINE_HEADS.has(head.name)) {
      const target = args[0] ? scmDefineTarget(args[0]) : null;
      if (target) {
        define(target.name, "function", form, target.header ? scmArglist(target.header) : undefined);
      }
      continue;
    }

    if (head.name === "define-values") {
      const names = args[0] && args[0].type === "list" ? scmForms(args[0]) : [];
      for (const n of names) if (n.type === "symbol") define(n.text, "variable", form);
      continue;
    }

    if (head.name === "define-record-type") {
      // (define-record-type name (ctor field...) pred (field accessor [modifier])...)
      const typeName = args[0] ? scmDefineTarget(args[0]) : null;
      if (typeName) define(typeName.name, "class", form);
      const ctor = args[1] && args[1].type === "list" ? scmHead(args[1]) : null;
      if (ctor) define(ctor.name, "function", args[1], scmArglist(args[1]));
      if (args[2] && args[2].type === "symbol") define(args[2].text, "function", args[2]);
      for (const spec of args.slice(3)) {
        if (spec.type !== "list") continue;
        // First symbol is the field; the rest are its accessor and modifier.
        for (const proc of scmForms(spec).slice(1)) {
          if (proc.type === "symbol") define(proc.text, "function", proc);
        }
      }
      continue;
    }

    if (SCM_STRUCT_HEADS.has(head.name)) {
      const target = args[0] ? scmDefineTarget(args[0]) : null;
      if (target) define(target.name, "class", form);
      continue;
    }

    if (head.name === "define-module") {
      // (define-module (my mod) #:use-module (a b) #:export (go))
      for (let i = 1; i < head.forms.length - 1; i++) {
        const kw = head.forms[i];
        if (kw.type !== "keyword") continue;
        const value = head.forms[i + 1];
        if (kw.text === "#:use-module") addImport(value);
        else if (kw.text === "#:export" || kw.text === "#:export-syntax" || kw.text === "#:re-export") {
          if (value.type === "list") addExports(scmForms(value));
        }
      }
      continue;
    }

    if (head.name === "import" || head.name === "use-modules" || head.name === "require") {
      for (const a of args) addImport(a);
      continue;
    }

    if (head.name === "load" || head.name === "include" || head.name === "include-ci") {
      for (const a of args) if (a.type === "string") addImport(a);
      continue;
    }

    if (head.name === "export" || head.name === "provide" || head.name === "export!" || head.name === "re-export") {
      addExports(args);
      continue;
    }
  }

  // Without an explicit `provide` / `export`, every top-level definition is
  // reachable from outside the file — the same assumption the Clojure walker
  // makes for `defn`.
  if (sawExportForm) {
    for (const name of declaredExports) {
      if (definedNames.has(name)) exports.push({ file: filePath, name });
    }
  } else {
    for (const name of definedNames) exports.push({ file: filePath, name });
  }

  // ── Phase 2: call edges ───────────────────────────────────────────
  const topLevelCaller = `<toplevel:${filePath}>`;

  for (const form of topForms) {
    if (form.type !== "list") continue;
    const head = scmHead(form);
    if (!head) {
      scmWalkCalls(form, topLevelCaller, definedNames, new Set(), emit);
      continue;
    }
    const args = head.forms.slice(1);

    if (SCM_DEFINE_HEADS.has(head.name) || SCM_SYNTAX_DEFINE_HEADS.has(head.name)) {
      const target = args[0] ? scmDefineTarget(args[0]) : null;
      // The header holds parameter names, never calls — start at the body,
      // with the parameters in scope so they can't be read as callees.
      const scope = new Set<string>();
      if (target?.header) scmBindParams(target.header, scope);
      for (const body of args.slice(1)) {
        scmWalkCalls(body, target?.name ?? topLevelCaller, definedNames, scope, emit);
      }
      continue;
    }

    if (head.name === "define-values") {
      const names = args[0] && args[0].type === "list"
        ? scmForms(args[0]).filter((n) => n.type === "symbol").map((n) => n.text)
        : [];
      for (const body of args.slice(1)) {
        scmWalkCalls(body, names[0] ?? topLevelCaller, definedNames, new Set(), emit);
      }
      continue;
    }

    // define-record-type / struct / module declarations have no evaluated
    // body worth walking; imports and exports were consumed in phase 1.
    if (
      head.name === "define-record-type" || SCM_STRUCT_HEADS.has(head.name) ||
      head.name === "define-module" || head.name === "import" || head.name === "require" ||
      head.name === "use-modules" || head.name === "export" || head.name === "provide" ||
      head.name === "export!" || head.name === "re-export" || head.name === "load"
    ) {
      continue;
    }

    scmWalkCalls(form, topLevelCaller, definedNames, new Set(), emit);
  }
}

/**
 * Walk one form for call edges. Binding constructs are handled explicitly:
 * their bound names go into `bound` (a fresh child scope) and the walker
 * starts at the initialisers and body, so a `let` clause head, a lambda
 * parameter or an internal define name is never read as a callee.
 */
function scmWalkCalls(
  node: any,
  caller: string,
  defined: Set<string>,
  bound: Set<string>,
  emit: Emit,
): void {
  if (node.type === "symbol") {
    if (!bound.has(node.text) && defined.has(node.text)) emit(caller, node.text);
    return;
  }
  if (!SCM_RECURSE_TYPES.has(node.type)) return;

  const head = node.type === "list" ? scmHead(node) : null;
  if (head) {
    const args = head.forms.slice(1);

    if (SCM_LAMBDA_HEADS.has(head.name)) {
      const scope = childScope(bound);
      // `(named-lambda (name . args) body)` puts the name inside the formals.
      scmBindParams(args[0], scope);
      for (const body of args.slice(1)) scmWalkCalls(body, caller, defined, scope, emit);
      return;
    }

    if (head.name === "case-lambda") {
      for (const clause of args) {
        if (clause.type !== "list") continue;
        const forms = scmForms(clause);
        const scope = childScope(bound);
        scmBindParams(forms[0], scope);
        for (const body of forms.slice(1)) scmWalkCalls(body, caller, defined, scope, emit);
      }
      return;
    }

    if (SCM_DEFINE_HEADS.has(head.name) || SCM_SYNTAX_DEFINE_HEADS.has(head.name)) {
      // Internal define: the body still belongs to the enclosing function,
      // but the name it binds is local — and visible to its siblings, so it
      // goes into the enclosing scope rather than a child of it.
      const target = args[0] ? scmDefineTarget(args[0]) : null;
      const scope = childScope(bound);
      if (target) {
        bound.add(target.name);
        scope.add(target.name);
        if (target.header) scmBindParams(target.header, scope);
      }
      for (const body of args.slice(1)) scmWalkCalls(body, caller, defined, scope, emit);
      return;
    }

    if (head.name === "define-values") {
      if (args[0]) scmBindFlat([args[0]], bound);
      for (const body of args.slice(1)) scmWalkCalls(body, caller, defined, bound, emit);
      return;
    }

    if (SCM_BINDING_HEADS.has(head.name)) {
      const scope = childScope(bound);
      // `(let loop ((i 0)) body)` — a named let puts the loop name first.
      let rest = args;
      if (head.name === "let" && rest[0] && rest[0].type === "symbol") {
        scope.add(rest[0].text);
        rest = rest.slice(1);
      }
      const bindings = rest[0];
      if (bindings && bindings.type === "list") {
        for (const clause of scmForms(bindings)) {
          if (clause.type !== "list") continue;
          const forms = scmForms(clause);
          scmBindFlat(forms.slice(0, 1), scope);
          // Initialisers are evaluated in the outer scope.
          for (const init of forms.slice(1)) scmWalkCalls(init, caller, defined, bound, emit);
        }
        rest = rest.slice(1);
      }
      for (const body of rest) scmWalkCalls(body, caller, defined, scope, emit);
      return;
    }

    if (!SCM_SPECIAL_FORMS.has(head.name) && !bound.has(head.name)) emit(caller, head.name);
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    scmWalkCalls(node.namedChild(i), caller, defined, bound, emit);
  }
}

// ── Common Lisp ──────────────────────────────────────────────────────

const CL_FORM_TYPES = new Set([
  "list_lit", "vec_lit", "map_lit", "set_lit", "sym_lit", "kwd_lit", "str_lit",
  "num_lit", "char_lit", "nil_lit", "complex_num_lit", "path_lit", "fancy_literal",
  "quoting_lit", "syn_quoting_lit", "unquoting_lit", "unquote_splicing_lit",
  "var_quoting_lit", "read_cond_lit", "splicing_read_cond_lit", "package_lit",
  "defun", "loop_macro", "dis_expr", "self_referential_reader_macro",
]);

/**
 * Types we descend through hunting for call sites. `quoting_lit` ('foo) is
 * data; `defun_header` holds a lambda list. Both stay out. The `loop_*`
 * clause nodes are in because `(loop ... do (frobnicate x))` hides real
 * calls behind them.
 */
const CL_RECURSE_TYPES = new Set([
  "list_lit", "vec_lit", "map_lit", "set_lit", "var_quoting_lit",
  "syn_quoting_lit", "unquoting_lit", "unquote_splicing_lit",
  "read_cond_lit", "splicing_read_cond_lit", "dis_expr", "defun",
  "loop_macro", "loop_clause", "for_clause", "do_clause", "while_clause",
  "with_clause", "condition_clause", "accumulation_clause", "repeat_clause",
  "termination_clause",
]);

const CL_VARIABLE_HEADS = new Set([
  "defvar", "defparameter", "defconstant", "define-symbol-macro", "defglobal",
]);

const CL_CLASS_HEADS = new Set([
  "defclass", "defstruct", "define-condition", "deftype",
]);

/** `(head ((name init...)...) body...)` — each clause binds one name. */
const CL_BINDING_HEADS = new Set([
  "let", "let*", "prog", "prog*", "do", "do*", "symbol-macrolet",
]);

/**
 * Same clause shape, but the clause head is a condition type rather than a
 * variable — `(handler-bind ((error #'log)) ...)`. The initialisers are
 * walked; nothing is added to scope.
 */
const CL_HANDLER_HEADS = new Set(["handler-bind", "restart-bind"]);

/** `(head ((name (params) body)...) body...)` — local function definitions. */
const CL_LOCAL_FN_HEADS = new Set(["flet", "labels", "macrolet"]);

/** `(head (var...) form body...)` — every symbol in the first form is bound. */
const CL_VAR_LIST_HEADS = new Set([
  "multiple-value-bind", "destructuring-bind", "with-slots", "with-accessors",
]);

/** `(head (var expr...) body...)` — the first symbol is bound, the rest is an expression. */
const CL_SINGLE_BINDING_HEADS = new Set([
  "dolist", "dotimes", "with-open-file", "with-output-to-string",
  "with-input-from-string", "do-symbols", "do-external-symbols", "do-all-symbols",
]);

/** Container forms whose body is effectively top-level; value = leading forms to drop. */
const CL_CONTAINER_HEADS = new Map<string, number>([["progn", 0], ["eval-when", 1]]);

const CL_SPECIAL_FORMS = new Set([
  // Special operators
  "block", "catch", "eval-when", "flet", "function", "go", "if", "labels",
  "let", "let*", "load-time-value", "locally", "macrolet", "multiple-value-call",
  "multiple-value-prog1", "progn", "progv", "quote", "return-from", "setq",
  "symbol-macrolet", "tagbody", "the", "throw", "unwind-protect",
  // Definition macros
  "defun", "defmacro", "defgeneric", "defmethod", "defvar", "defparameter",
  "defconstant", "defclass", "defstruct", "deftype", "define-condition",
  "defpackage", "define-package", "in-package", "defsetf", "define-setf-expander",
  "define-symbol-macro", "define-compiler-macro", "define-modify-macro", "defglobal",
  // Control flow / binding macros
  "and", "or", "not", "when", "unless", "cond", "case", "ccase", "ecase",
  "typecase", "etypecase", "ctypecase", "handler-case", "handler-bind",
  "restart-case", "restart-bind", "ignore-errors", "loop", "do", "do*",
  "dolist", "dotimes", "prog", "prog*", "prog1", "prog2", "return",
  "multiple-value-bind", "destructuring-bind", "with-slots", "with-accessors",
  "with-open-file", "with-open-stream", "with-output-to-string",
  "with-input-from-string", "with-standard-io-syntax", "declare", "declaim",
  "proclaim", "lambda", "setf", "psetf", "push", "pop", "pushnew", "incf", "decf",
  "check-type", "assert", "otherwise", "t", "nil",
  "do-symbols", "do-external-symbols", "do-all-symbols",
]);

/** Text of a symbol, with `pkg::name` normalized to `pkg:name`. */
function clSymText(node: any): string | null {
  if (node.type === "sym_lit") return node.text;
  if (node.type === "package_lit") return node.text.replace("::", ":");
  return null;
}

/** Value of a package designator: `:foo`, `#:foo`, `"FOO"` or `foo`. */
function clDesignator(node: any): string | null {
  if (!node) return null;
  if (node.type === "kwd_lit") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === "kwd_symbol") return c.text;
    }
    return node.text.replace(/^#?:/, "");
  }
  if (node.type === "str_lit") return stringValue(node);
  if (node.type === "sym_lit") return node.text;
  return null;
}

function clForms(node: any): any[] {
  const out: any[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (CL_FORM_TYPES.has(c.type)) out.push(c);
  }
  return out;
}

/** Head symbol of a list, or null when it starts with anything else. */
function clHead(list: any): { name: string; forms: any[] } | null {
  const forms = clForms(list);
  if (forms.length === 0) return null;
  const name = clSymText(forms[0]);
  return name ? { name, forms } : null;
}

/**
 * A `(defun|defmacro|defgeneric|defmethod|lambda ...)` list, destructured.
 * The grammar wraps all five in a `defun` node with a `defun_header` child,
 * so this is the one shape that doesn't go through `clHead`.
 */
interface ClDefun {
  keyword: string;
  /** null for `lambda` and for `(defun (setf place) ...)`, which has no plain name. */
  name: string | null;
  signature?: string;
  header: any;
  body: any[];
}

function clDefun(list: any): ClDefun | null {
  const forms = clForms(list);
  if (forms.length === 0 || forms[0].type !== "defun") return null;
  const node = forms[0];
  let header: any = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i).type === "defun_header") { header = node.namedChild(i); break; }
  }
  if (!header) return null;
  const keyword = header.childForFieldName("keyword")?.text;
  if (!keyword) return null;
  const nameNode = header.childForFieldName("function_name");
  const lambdaList = header.childForFieldName("lambda_list");
  const body: any[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type !== "defun_header" && CL_FORM_TYPES.has(c.type)) body.push(c);
  }
  return {
    keyword,
    name: nameNode ? clSymText(nameNode) : null,
    signature: lambdaList ? collapse(lambdaList.text) : undefined,
    header,
    body,
  };
}

/**
 * Add every symbol a form binds. Used where the whole list is names —
 * `(multiple-value-bind (q r) ...)`, `(with-slots (x y) ...)`.
 */
function clBindFlat(form: any, into: Set<string>): void {
  if (!form) return;
  if (form.type === "sym_lit") { into.add(form.text); return; }
  for (const f of clForms(form)) if (f.type === "sym_lit") into.add(f.text);
}

/**
 * Add the names a lambda list binds. Only the first symbol of a nested list
 * counts: `(x 0)` is an optional argument with a default, and `((s point))`
 * is a defmethod specializer whose second symbol is a class, not a binding.
 * `&optional` and friends are harmless — nothing is named `&key`.
 */
function clBindParams(form: any, into: Set<string>): void {
  if (!form) return;
  if (form.type === "sym_lit") { into.add(form.text); return; }
  for (const f of clForms(form)) {
    if (f.type === "sym_lit") into.add(f.text);
    else if (f.type === "list_lit") {
      const first = clForms(f)[0];
      if (first && first.type === "sym_lit") into.add(first.text);
    }
  }
}

/** Flatten `progn` / `eval-when` wrappers around top-level forms. */
function clTopLevelForms(root: any): any[] {
  const out: any[] = [];
  const visit = (forms: any[]): void => {
    for (const f of forms) {
      const head = f.type === "list_lit" ? clHead(f) : null;
      const skip = head ? CL_CONTAINER_HEADS.get(head.name) : undefined;
      if (head && skip !== undefined) visit(head.forms.slice(1 + skip));
      else out.push(f);
    }
  };
  visit(clForms(root));
  return out;
}

export function walkCommonLisp(
  rootNode: any,
  filePath: string,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  callSet: Set<string>,
  fileNode?: FileNode,
): void {
  const emit = makeEmit(calls, callSet);
  const topForms = clTopLevelForms(rootNode);

  // ── Package pass ─────────────────────────────────────────────────
  // `(in-package :foo)` fixes the package every later define belongs to, and
  // a `(defpackage ... (:export ...))` list, when present, is authoritative
  // about what leaves the package. Both can sit anywhere in the file, so
  // they're read before any name is minted.
  let pkg: string | null = null;
  const declaredExports: string[] = [];
  let sawExportList = false;

  for (const form of topForms) {
    if (form.type !== "list_lit") continue;
    const head = clHead(form);
    if (!head) continue;

    if (head.name === "in-package") {
      pkg = clDesignator(head.forms[1]) ?? pkg;
      continue;
    }
    if (head.name === "defpackage" || head.name === "define-package" || head.name === "uiop:define-package") {
      for (const opt of head.forms.slice(2)) {
        if (opt.type !== "list_lit") continue;
        const optForms = clForms(opt);
        const optName = clDesignator(optForms[0]);
        if (optName === "use" || optName === "import-from" || optName === "use-reexport") {
          for (const d of optForms.slice(1)) {
            const name = clDesignator(d);
            if (name) imports.push({ file: filePath, name, source: name });
          }
        } else if (optName === "export") {
          sawExportList = true;
          for (const d of optForms.slice(1)) {
            const name = clDesignator(d);
            if (name) declaredExports.push(name);
          }
        }
      }
    }
  }

  if (pkg !== null && fileNode) fileNode.namespace = pkg;

  const qualify = (name: string): string =>
    pkg !== null && !name.includes(":") ? `${pkg}:${name}` : name;

  const definedNames = new Set<string>();
  const callableNames = new Set<string>();
  const define = (bare: string, kind: DefinesFact["kind"], node: any, signature?: string): void => {
    const name = qualify(bare);
    if (definedNames.has(name)) return;
    definedNames.add(name);
    if (kind === "function") callableNames.add(name);
    defines.push({ file: filePath, name, kind, line: node.startPosition.row + 1, signature });
  };

  // ── Phase 1: definitions ─────────────────────────────────────────
  for (const form of topForms) {
    if (form.type !== "list_lit") continue;

    const fn = clDefun(form);
    if (fn) {
      // defmethod implements an existing generic — it names no new function.
      if (fn.name && fn.keyword !== "defmethod" && fn.keyword !== "lambda") {
        define(fn.name, "function", form, fn.signature);
      }
      continue;
    }

    const head = clHead(form);
    if (!head) continue;
    const args = head.forms.slice(1);

    if (CL_VARIABLE_HEADS.has(head.name)) {
      const name = args[0] ? clSymText(args[0]) : null;
      if (name) define(name, "variable", form);
      continue;
    }

    if (CL_CLASS_HEADS.has(head.name)) {
      // `(defstruct (pt (:conc-name p-)) x y)` names the struct in a list.
      const subject = args[0];
      const name = subject
        ? clSymText(subject) ?? (subject.type === "list_lit" ? clHead(subject)?.name ?? null : null)
        : null;
      if (name) define(name, "class", form);
      continue;
    }
  }

  if (sawExportList) {
    for (const bare of declaredExports) {
      const name = qualify(bare);
      if (definedNames.has(name)) exports.push({ file: filePath, name });
    }
  } else {
    for (const name of callableNames) exports.push({ file: filePath, name });
  }

  // ── Phase 2: call edges ──────────────────────────────────────────
  const topLevelCaller = `<toplevel:${filePath}>`;

  for (const form of topForms) {
    if (form.type !== "list_lit") continue;

    const fn = clDefun(form);
    if (fn) {
      // A defmethod body is attributed to the generic function it implements,
      // so a helper only reachable through dispatch doesn't look dead.
      const caller = fn.name ? qualify(fn.name) : topLevelCaller;
      const scope = new Set<string>();
      clBindParams(fn.header.childForFieldName("lambda_list"), scope);
      for (const body of fn.body) clWalkCalls(body, caller, definedNames, pkg, scope, emit);
      continue;
    }

    const head = clHead(form);
    if (!head) {
      clWalkCalls(form, topLevelCaller, definedNames, pkg, new Set(), emit);
      continue;
    }
    const args = head.forms.slice(1);

    if (CL_VARIABLE_HEADS.has(head.name)) {
      const bare = args[0] ? clSymText(args[0]) : null;
      const caller = bare ? qualify(bare) : topLevelCaller;
      for (const value of args.slice(1)) clWalkCalls(value, caller, definedNames, pkg, new Set(), emit);
      continue;
    }

    if (
      CL_CLASS_HEADS.has(head.name) || head.name === "defpackage" ||
      head.name === "define-package" || head.name === "uiop:define-package" ||
      head.name === "in-package"
    ) {
      continue;
    }

    clWalkCalls(form, topLevelCaller, definedNames, pkg, new Set(), emit);
  }
}

/**
 * Walk one form for call edges. Same contract as `scmWalkCalls`: binding
 * constructs put their names into a child scope and the walker resumes at the
 * initialisers and body, so `let` variables, lambda-list parameters and
 * `labels` local functions never surface as global callees.
 */
function clWalkCalls(
  node: any,
  caller: string,
  defined: Set<string>,
  pkg: string | null,
  bound: Set<string>,
  emit: Emit,
): void {
  const qualify = (name: string): string =>
    pkg !== null && !name.includes(":") ? `${pkg}:${name}` : name;

  /**
   * A bare name belongs to the current package only if this file defines it.
   * Everything else — `subseq`, `format`, a function from another file in the
   * same package — stays as written, so the standard library doesn't get a
   * separate node per package that happens to call it.
   */
  const resolve = (bare: string): string => {
    const qualified = qualify(bare);
    return defined.has(qualified) ? qualified : bare;
  };

  if (node.type === "sym_lit" || node.type === "package_lit") {
    const bare = clSymText(node);
    if (bare && !bound.has(bare)) {
      const name = qualify(bare);
      if (defined.has(name)) emit(caller, name);
    }
    return;
  }
  if (!CL_RECURSE_TYPES.has(node.type)) return;

  const fn = node.type === "list_lit" ? clDefun(node) : null;
  if (fn) {
    // A nested `(lambda (x) ...)` — its parameters shadow for the body only.
    const scope = childScope(bound);
    clBindParams(fn.header.childForFieldName("lambda_list"), scope);
    for (const body of fn.body) clWalkCalls(body, caller, defined, pkg, scope, emit);
    return;
  }

  const head = node.type === "list_lit" ? clHead(node) : null;
  if (head) {
    const args = head.forms.slice(1);

    if (CL_LOCAL_FN_HEADS.has(head.name)) {
      // ((name (params) body...) ...) — the local names are visible in the
      // body and, for `labels`, in each other.
      const clauses = args[0] && args[0].type === "list_lit" ? clForms(args[0]) : [];
      const scope = childScope(bound);
      for (const clause of clauses) {
        if (clause.type !== "list_lit") continue;
        const name = clForms(clause)[0];
        if (name && name.type === "sym_lit") scope.add(name.text);
      }
      for (const clause of clauses) {
        if (clause.type !== "list_lit") continue;
        const forms = clForms(clause);
        const inner = childScope(scope);
        clBindParams(forms[1], inner);
        for (const body of forms.slice(2)) clWalkCalls(body, caller, defined, pkg, inner, emit);
      }
      for (const body of args.slice(1)) clWalkCalls(body, caller, defined, pkg, scope, emit);
      return;
    }

    if (CL_BINDING_HEADS.has(head.name) || CL_HANDLER_HEADS.has(head.name)) {
      const bindsNames = CL_BINDING_HEADS.has(head.name);
      const scope = childScope(bound);
      let rest = args;
      const bindings = args[0];
      if (bindings && bindings.type === "list_lit") {
        for (const clause of clForms(bindings)) {
          // `(let (a b) ...)` binds without initialising.
          if (clause.type === "sym_lit") {
            if (bindsNames) scope.add(clause.text);
            continue;
          }
          if (clause.type !== "list_lit") continue;
          const forms = clForms(clause);
          if (bindsNames && forms[0] && forms[0].type === "sym_lit") scope.add(forms[0].text);
          // Initialisers are evaluated in the outer scope.
          for (const init of forms.slice(1)) clWalkCalls(init, caller, defined, pkg, bound, emit);
        }
        rest = args.slice(1);
      }
      for (const body of rest) clWalkCalls(body, caller, defined, pkg, scope, emit);
      return;
    }

    if (CL_VAR_LIST_HEADS.has(head.name)) {
      const scope = childScope(bound);
      clBindFlat(args[0], scope);
      for (const body of args.slice(1)) clWalkCalls(body, caller, defined, pkg, scope, emit);
      return;
    }

    if (CL_SINGLE_BINDING_HEADS.has(head.name)) {
      const scope = childScope(bound);
      const spec = args[0];
      if (spec && spec.type === "list_lit") {
        const forms = clForms(spec);
        if (forms[0] && forms[0].type === "sym_lit") scope.add(forms[0].text);
        // `(dolist (p (all-pairs)) ...)` — the sequence form is a real call.
        for (const expr of forms.slice(1)) clWalkCalls(expr, caller, defined, pkg, bound, emit);
      }
      for (const body of args.slice(1)) clWalkCalls(body, caller, defined, pkg, scope, emit);
      return;
    }

    if (!CL_SPECIAL_FORMS.has(head.name) && !bound.has(head.name)) {
      emit(caller, resolve(head.name));
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "defun_header") continue;
    clWalkCalls(child, caller, defined, pkg, bound, emit);
  }
}

// ── Project-wide resolution ──────────────────────────────────────────

/**
 * Connect bare Common Lisp call edges to the package-qualified define they
 * name. A CL package spans files — `(defun start () (bootstrap))` in one
 * file and `(defun bootstrap ...)` in another are the same package — so the
 * per-file walk can't know whether a bare callee is a sibling define or a
 * standard-library function. It leaves the name bare, and this pass, which
 * runs once every file's defines are known, promotes the ones that match.
 *
 * A caller's package comes from its own qualified name, or, for the synthetic
 * `<toplevel:file>` caller, from that file's `(in-package ...)`. Names
 * that don't resolve stay bare: they belong to another package or to the
 * standard library, and inventing `my-package:subseq` would fragment those
 * into one node per calling package.
 */
export function resolveCommonLispPackageCalls(graph: CodeGraph): void {
  const lispFiles = new Set(
    (graph.files ?? []).filter((f) => f.language === "commonlisp").map((f) => f.path),
  );
  if (lispFiles.size === 0) return;

  const definedNames = new Set(graph.defines.map((d) => d.name));
  const packageByFile = new Map<string, string>();
  for (const f of graph.files ?? []) {
    if (f.namespace) packageByFile.set(f.path, f.namespace);
  }

  const packageOfCaller = (caller: string): string | null => {
    const toplevel = /^<toplevel:(.*)>$/.exec(caller);
    if (toplevel) return packageByFile.get(toplevel[1]) ?? null;
    const sep = caller.indexOf(":");
    return sep > 0 ? caller.slice(0, sep) : null;
  };

  const seen = new Set(graph.calls.map((c) => `${c.caller}->${c.callee}`));
  for (const call of graph.calls) {
    if (call.callee.includes(":")) continue;
    const pkg = packageOfCaller(call.caller);
    if (!pkg) continue;
    const qualified = `${pkg}:${call.callee}`;
    if (!definedNames.has(qualified)) continue;
    seen.delete(`${call.caller}->${call.callee}`);
    call.callee = qualified;
    seen.add(`${call.caller}->${qualified}`);
  }

  // Rewriting can collapse two edges onto one pair; drop the duplicates.
  const kept = new Set<string>();
  const deduped = graph.calls.filter((c) => {
    const key = `${c.caller}->${c.callee}`;
    if (c.caller === c.callee || kept.has(key)) return false;
    kept.add(key);
    return true;
  });
  graph.calls.length = 0;
  graph.calls.push(...deduped);
}
