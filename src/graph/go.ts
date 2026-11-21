// Go extraction + project-wide method resolution.
//
// Names are package-qualified by the file's package key (its directory
// relative to the nearest go.mod, e.g. `internal/store`): functions
// `<pkg>.f`, types `<pkg>.T`, methods `<pkg>.T.M`, so same-named types and
// functions in different packages stay distinct. Interface methods are
// defined as `<pkg>.Iface.M`, with dispatch edges to `<pkg>.Struct.M` for
// every struct whose method-name set covers the interface (Go has no
// `implements`). Calls on a receiver chain (`s.store.Get()`) resolve through
// receiver/param/local, package-var and struct-field types in a pass over
// the whole batch, since a type's fields, methods, package vars and
// implementations can live in other files.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  CallsFact, CodeGraph, ContainsFact, DefinesFact, ExportsFact, GoFileInfo, GoPendingCall, ImportsFact,
} from "./types.js";
import { collapseSignature } from "./graph-util.js";

/** Cap on fan-out per interface / unresolved method name. */
const MAX_GO_TARGETS = 50;

/** Predeclared functions and types: never package-qualified. */
const GO_BUILTINS = new Set([
  "len", "cap", "make", "new", "append", "copy", "delete", "panic", "recover", "print", "println",
  "close", "clear", "min", "max", "complex", "real", "imag",
  "any", "bool", "byte", "comparable", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
]);

/** Per-file naming context: own package key and import alias → package key. */
interface GoCtx {
  key: string;
  imports: Map<string, string>;
}

interface GoMod { dir: string; module: string }

const goModByDir = new Map<string, GoMod | null>();

/** Forget memoized go.mod lookups; called once per extraction batch. */
export function resetGoModCache(): void {
  goModByDir.clear();
}

function findGoMod(dir: string): GoMod | null {
  const memo = goModByDir.get(dir);
  if (memo !== undefined) return memo;
  let found: GoMod | null = null;
  try {
    const m = /^\s*module\s+"?([^\s"]+)/m.exec(readFileSync(join(dir, "go.mod"), "utf-8"));
    if (m) found = { dir, module: m[1] };
  } catch {
    // No readable go.mod here (or a virtual path): keep walking up.
  }
  if (!found) {
    const parent = dirname(dir);
    found = parent === dir ? null : findGoMod(parent);
  }
  goModByDir.set(dir, found);
  return found;
}

function packageClause(rootNode: any): string {
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const n = rootNode.namedChild(i);
    if (n.type === "package_clause") return n.namedChild(0)?.text ?? "";
  }
  return "";
}

/** Package key: dir relative to the nearest go.mod, else the package clause name. */
function goPackageKey(filePath: string, clause: string): { key: string; mod: GoMod | null } {
  const dir = resolve(dirname(filePath));
  const mod = findGoMod(dir);
  const rel = mod ? relative(mod.dir, dir).split(sep).join("/") : "";
  if (!rel) return { key: clause, mod };
  return { key: clause.endsWith("_test") ? `${rel}_test` : rel, mod };
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1);
}

/** Qualified type key for a Go type node: `*pkg.Foo[T]` → `<pkg key>.Foo`. "" when not a named type. */
function goTypeName(node: any, ctx: GoCtx): string {
  if (!node) return "";
  switch (node.type) {
    case "type_identifier":
      return GO_BUILTINS.has(node.text) ? node.text : `${ctx.key}.${node.text}`;
    case "pointer_type":
    case "parenthesized_type":
      for (let i = 0; i < node.namedChildCount; i++) {
        const n = goTypeName(node.namedChild(i), ctx);
        if (n) return n;
      }
      return "";
    case "qualified_type": {
      const pkg = node.childForFieldName("package")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      return name ? `${ctx.imports.get(pkg) ?? pkg}.${name}` : "";
    }
    case "generic_type":
      return goTypeName(node.childForFieldName("type"), ctx);
    default:
      return "";
  }
}

function goSignature(node: any): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  let sig = params.text;
  const result = node.childForFieldName("result");
  if (result) sig += " " + result.text;
  return collapseSignature(sig);
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function receiverOf(node: any, ctx: GoCtx): { name: string; type: string } | null {
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return null;
  for (let i = 0; i < receiver.namedChildCount; i++) {
    const param = receiver.namedChild(i);
    if (param.type !== "parameter_declaration") continue;
    const type = goTypeName(param.childForFieldName("type"), ctx);
    if (!type) continue;
    return { name: param.childForFieldName("name")?.text ?? "", type };
  }
  return null;
}

/** Type of a value expression: `T{}`, `&T{}`, or by convention `NewT(...)` / `pkg.NewT(...)`. */
function literalType(expr: any, ctx: GoCtx): string {
  if (!expr) return "";
  if (expr.type === "unary_expression") return literalType(expr.childForFieldName("operand"), ctx);
  if (expr.type === "parenthesized_expression") return literalType(expr.namedChild(0), ctx);
  if (expr.type === "composite_literal") return goTypeName(expr.childForFieldName("type"), ctx);
  if (expr.type === "call_expression") {
    const fn = expr.childForFieldName("function");
    let pkg = ctx.key;
    let name = fn?.text;
    if (fn?.type === "selector_expression") {
      const operand = fn.childForFieldName("operand");
      if (operand?.type !== "identifier") return "";
      pkg = ctx.imports.get(operand.text) ?? operand.text;
      name = fn.childForFieldName("field")?.text;
    }
    return /^New[A-Z]\w*$/.test(name ?? "") ? `${pkg}.${name!.slice(3)}` : "";
  }
  return "";
}

function namedChildrenOfType(node: any, type: string): any[] {
  const out: any[] = [];
  if (!node) return out;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) out.push(c);
  }
  return out;
}

/** Record `name -> type` for every parameter in a parameter_list. */
function addParams(params: any, scope: Map<string, string>, ctx: GoCtx): void {
  if (!params) return;
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue;
    const type = p.type === "parameter_declaration" ? goTypeName(p.childForFieldName("type"), ctx) : "";
    for (const id of p.childrenForFieldName("name")) setVar(scope, id.text, type);
  }
}

// shortcut: one flat scope per function (block shadowing ignored); first known type wins.
function setVar(scope: Map<string, string>, name: string, type: string): void {
  if (name === "_") return;
  if (!scope.has(name) || (!scope.get(name) && type)) scope.set(name, type);
}

function addVarSpec(spec: any, scope: Map<string, string>, ctx: GoCtx): void {
  const declared = goTypeName(spec.childForFieldName("type"), ctx);
  const value = spec.childForFieldName("value");
  spec.childrenForFieldName("name").forEach((id: any, i: number) =>
    setVar(scope, id.text, declared || literalType(value?.namedChild(i), ctx)));
}

/** Record locals declared by `node`. Go declares before use, so one in-order walk sees them in time. */
function declareLocals(node: any, scope: Map<string, string>, ctx: GoCtx): void {
  switch (node.type) {
    case "short_var_declaration": {
      const left = namedChildrenOfType(node.childForFieldName("left"), "identifier");
      const right = node.childForFieldName("right");
      const values = right ? Array.from({ length: right.namedChildCount }, (_, i) => right.namedChild(i)) : [];
      left.forEach((id, i) => setVar(scope, id.text, left.length === values.length ? literalType(values[i], ctx) : ""));
      break;
    }
    case "var_spec":
      addVarSpec(node, scope, ctx);
      break;
    case "range_clause":
    case "receive_statement":
      for (const id of namedChildrenOfType(node.childForFieldName("left"), "identifier")) setVar(scope, id.text, "");
      break;
    case "type_switch_statement":
      for (const id of namedChildrenOfType(node.childForFieldName("alias"), "identifier")) setVar(scope, id.text, "");
      break;
    case "func_literal":
      addParams(node.childForFieldName("parameters"), scope, ctx);
      addParams(node.childForFieldName("result"), scope, ctx);
      break;
  }
}

/** `a.b.c` → ["a","b","c"]; null when the chain doesn't start at an identifier. */
function selectorChain(node: any): string[] | null {
  if (node.type === "identifier") return [node.text];
  if (node.type === "selector_expression") {
    const head = selectorChain(node.childForFieldName("operand"));
    const field = node.childForFieldName("field")?.text;
    return head && field ? [...head, field] : null;
  }
  return null;
}

/** Qualified callee of a (possibly instantiated generic) function: `f`, `f[T]`, `pkg.F[T]`. */
function funcName(node: any, ctx: GoCtx): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "type_identifier") {
    return GO_BUILTINS.has(node.text) ? node.text : `${ctx.key}.${node.text}`;
  }
  if (node.type === "qualified_type" || node.type === "selector_expression") {
    const pkg = node.childForFieldName(node.type === "qualified_type" ? "package" : "operand")?.text;
    const name = node.childForFieldName(node.type === "qualified_type" ? "name" : "field")?.text;
    return pkg && name ? `${ctx.imports.get(pkg) ?? pkg}.${name}` : null;
  }
  if (node.type === "generic_type") return funcName(node.childForFieldName("type"), ctx);
  if (node.type === "index_expression") return funcName(node.childForFieldName("operand"), ctx);
  return null;
}

function extractGoCalls(
  node: any,
  caller: string,
  scope: Map<string, string>,
  ctx: GoCtx,
  addCall: (callee: string) => void,
  pending: GoPendingCall[],
): void {
  if (!node) return;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    declareLocals(child, scope, ctx);
    if (child.type === "call_expression") {
      const fn = child.childForFieldName("function");
      if (fn?.type === "selector_expression") {
        const method = fn.childForFieldName("field")?.text;
        const chain = selectorChain(fn.childForFieldName("operand"));
        if (method) {
          if (!chain) {
            // Receiver is an expression result (`f().M()`): type unknown.
            pending.push({ caller, method, headType: "", path: [] });
          } else if (scope.has(chain[0])) {
            pending.push({ caller, method, headType: scope.get(chain[0])!, path: chain.slice(1) });
          } else if (ctx.imports.has(chain[0])) {
            if (chain.length === 1) addCall(`${ctx.imports.get(chain[0])}.${method}`);
            else pending.push({ caller, method, headType: "", path: [] });
          } else {
            // A package var (maybe from another file) or an import whose name we didn't guess.
            pending.push({ caller, method, headType: "", headVar: chain[0], path: chain.slice(1) });
          }
        }
      } else {
        const name = funcName(fn, ctx);
        if (name) addCall(name);
      }
    } else if (child.type === "type_conversion_expression") {
      // tree-sitter-go parses `f[T](x)` as a conversion to `f[T]`.
      const t = child.childForFieldName("type");
      if (t?.type === "generic_type") {
        const name = funcName(t, ctx);
        if (name) addCall(name);
      }
    }
    extractGoCalls(child, caller, scope, ctx, addCall, pending);
  }
}

function extractGoImports(
  node: any, filePath: string, imports: ImportsFact[], ctx: GoCtx, mod: GoMod | null,
): void {
  const specs = node.type === "import_spec" ? [node] : [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === "import_spec") specs.push(c);
    if (c.type === "import_spec_list") specs.push(...namedChildrenOfType(c, "import_spec"));
  }
  for (const spec of specs) {
    const pathNode = spec.childForFieldName("path");
    if (!pathNode) continue;
    const source = pathNode.text.slice(1, -1);
    const name = source.split("/").pop() ?? source;
    imports.push({ file: filePath, name, source });
    const alias = spec.childForFieldName("name")?.text;
    if (alias === "_" || alias === ".") continue;
    const local = alias ?? goPackageName(source);
    const inModule = mod && source.startsWith(`${mod.module}/`);
    ctx.imports.set(local, inModule ? source.slice(mod.module.length + 1) : local);
  }
}

// shortcut: guesses the package name from the path (`.../v2`, `yaml.v3`, `go-foo`);
// a mismatch only sends that call through the package-var check in resolveGoCalls.
function goPackageName(source: string): string {
  const segs = source.split("/");
  let last = segs.pop() ?? source;
  if (/^v\d+$/.test(last) && segs.length) last = segs.pop()!;
  return last.replace(/\.v\d+$/, "").replace(/^go-/, "");
}

export function walkGo(
  rootNode: any,
  filePath: string,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): GoFileInfo {
  const { key, mod } = goPackageKey(filePath, packageClause(rootNode));
  const ctx: GoCtx = { key, imports: new Map() };
  const info: GoFileInfo = { file: filePath, pkg: key, pkgVars: {}, structFields: [], interfaces: [], pendingCalls: [] };
  const pkgScope = new Map<string, string>();
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const node = rootNode.namedChild(i);
    if (node.type === "import_declaration") extractGoImports(node, filePath, imports, ctx, mod);
  }
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const node = rootNode.namedChild(i);
    if (node.type !== "var_declaration") continue;
    for (const c of Array.from({ length: node.namedChildCount }, (_, j) => node.namedChild(j))) {
      if (c.type === "var_spec") addVarSpec(c, pkgScope, ctx);
      for (const spec of namedChildrenOfType(c, "var_spec")) addVarSpec(spec, pkgScope, ctx);
    }
  }
  info.pkgVars = Object.fromEntries(pkgScope);

  const visitBody = (node: any, caller: string, scope: Map<string, string>) => {
    const body = node.childForFieldName("body");
    extractGoCalls(body, caller, scope, ctx, (callee) => {
      const k = `${caller}->${callee}`;
      if (!callSet.has(k)) {
        callSet.add(k);
        calls.push({ caller, callee });
      }
    }, info.pendingCalls);
  };

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    const line = node.startPosition.row + 1;

    switch (node.type) {
      case "function_declaration": {
        const fn = node.childForFieldName("name")?.text;
        if (!fn) break;
        const name = `${key}.${fn}`;
        defines.push({ file: filePath, name, kind: "function", line, signature: goSignature(node) });
        if (isExported(fn)) exports.push({ file: filePath, name });
        const scope = new Map<string, string>();
        addParams(node.childForFieldName("parameters"), scope, ctx);
        addParams(node.childForFieldName("result"), scope, ctx);
        visitBody(node, name, scope);
        break;
      }

      case "method_declaration": {
        const method = node.childForFieldName("name")?.text;
        if (!method) break;
        const recv = receiverOf(node, ctx);
        const name = `${recv?.type ?? key}.${method}`;
        defines.push({ file: filePath, name, kind: "method", line, signature: goSignature(node) });
        if (recv) contains.push({ parent: recv.type, child: name });
        if (isExported(method)) exports.push({ file: filePath, name });
        const scope = new Map<string, string>();
        if (recv?.name) setVar(scope, recv.name, recv.type);
        addParams(node.childForFieldName("parameters"), scope, ctx);
        addParams(node.childForFieldName("result"), scope, ctx);
        visitBody(node, name, scope);
        break;
      }

      case "type_declaration": {
        for (const spec of namedChildrenOfType(node, "type_spec")) {
          const simple = spec.childForFieldName("name")?.text;
          const typeNode = spec.childForFieldName("type");
          if (!simple || !typeNode) continue;
          const name = `${key}.${simple}`;
          const specLine = spec.startPosition.row + 1;
          const kind = typeNode.type === "interface_type" ? "interface" : "class";
          defines.push({ file: filePath, name, kind, line: specLine });
          if (isExported(simple)) exports.push({ file: filePath, name });

          if (typeNode.type === "interface_type") {
            // shortcut: an interface embedding types (`interface{ io.Reader; Write() }`) has an
            // unknown full method set, so it gets no dispatch edges.
            const embeds = namedChildrenOfType(typeNode, "type_elem").length > 0;
            const methods: string[] = [];
            for (const m of namedChildrenOfType(typeNode, "method_elem")) {
              const mName = m.childForFieldName("name")?.text;
              if (!mName) continue;
              methods.push(mName);
              const qn = `${name}.${mName}`;
              defines.push({ file: filePath, name: qn, kind: "method", line: m.startPosition.row + 1, signature: goSignature(m) });
              contains.push({ parent: name, child: qn });
              if (isExported(mName)) exports.push({ file: filePath, name: qn });
            }
            info.interfaces.push(embeds ? { name, methods, embeds } : { name, methods });
          } else if (typeNode.type === "struct_type") {
            const fields: Record<string, string> = {};
            const list = namedChildrenOfType(typeNode, "field_declaration_list")[0];
            for (const f of namedChildrenOfType(list, "field_declaration")) {
              const type = goTypeName(f.childForFieldName("type"), ctx);
              const names = f.childrenForFieldName("name");
              for (const id of names) fields[id.text] = type;
              // shortcut: embedded fields are addressable by simple type name and their methods
              // are promoted one level deep; their fields aren't promoted.
              if (names.length === 0 && type) fields[lastSegment(type)] = type;
            }
            info.structFields.push({ typeName: name, fields });
          }
        }
        break;
      }
    }
  }
  return info;
}

/**
 * Project-wide pass: resolve pending receiver calls to `<pkg>.Type.Method` and
 * add `<pkg>.Iface.Method -> <pkg>.Struct.Method` dispatch edges.
 */
export function resolveGoCalls(graph: CodeGraph, infos: GoFileInfo[]): void {
  const goFiles = new Set(infos.map((i) => i.file));
  const fields = new Map<string, Record<string, string>>();
  const ifaces = new Map<string, Set<string>>();
  const opaque = new Set<string>();
  // Interface method defines, by file: a struct may share its name with an interface in another package.
  const ifaceMethodDefs = new Set<string>();
  const pkgVars = new Map<string, Map<string, string>>();
  for (const info of infos) {
    const vars = pkgVars.get(info.pkg) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(info.pkgVars)) if (!vars.get(k)) vars.set(k, v);
    pkgVars.set(info.pkg, vars);
    for (const s of info.structFields) fields.set(s.typeName, { ...fields.get(s.typeName), ...s.fields });
    for (const i of info.interfaces) {
      const set = ifaces.get(i.name) ?? new Set<string>();
      for (const m of i.methods) {
        set.add(m);
        ifaceMethodDefs.add(`${info.file}\0${i.name}.${m}`);
      }
      ifaces.set(i.name, set);
      if (i.embeds) opaque.add(i.name);
    }
  }

  // Concrete (non-interface) method sets, from `Type.Method` defines.
  const methodsByType = new Map<string, Set<string>>();
  const owners = new Map<string, string[]>();
  for (const d of graph.defines) {
    if (d.kind !== "method" || !goFiles.has(d.file)) continue;
    // Type and method names never contain dots; package keys may.
    const dot = d.name.lastIndexOf(".");
    if (dot <= 0) continue;
    const type = d.name.slice(0, dot);
    const method = d.name.slice(dot + 1);
    if (ifaceMethodDefs.has(`${d.file}\0${d.name}`)) continue;
    const set = methodsByType.get(type) ?? new Set<string>();
    if (!set.has(method)) {
      set.add(method);
      const list = owners.get(method);
      if (list) list.push(type);
      else owners.set(method, [type]);
    }
    methodsByType.set(type, set);
  }
  // Sorted so the interface cap below is independent of file/cache order.
  for (const list of owners.values()) list.sort();

  const seen = new Set(graph.calls.map((c) => `${c.caller}->${c.callee}`));
  const add = (caller: string, callee: string) => {
    const key = `${caller}->${callee}`;
    if (seen.has(key)) return;
    seen.add(key);
    graph.calls.push({ caller, callee });
  };

  for (const [iface, want] of ifaces) {
    if (want.size === 0 || opaque.has(iface)) continue;
    // Implementers must own every method, so scanning the rarest method's owners suffices.
    let rarest: string[] = [];
    let first = true;
    for (const m of want) {
      const list = owners.get(m) ?? [];
      if (first || list.length < rarest.length) rarest = list;
      first = false;
    }
    // Cap: only the first MAX_GO_TARGETS implementers by type name get dispatch edges.
    let n = 0;
    for (const type of rarest) {
      if (n >= MAX_GO_TARGETS) break;
      if (type === iface) continue;
      const have = methodsByType.get(type)!;
      let covers = true;
      for (const m of want) if (!have.has(m)) { covers = false; break; }
      if (!covers) continue;
      n++;
      for (const m of want) add(`${iface}.${m}`, `${type}.${m}`);
    }
  }

  const defines = (type: string, m: string) => !!(methodsByType.get(type)?.has(m) || ifaces.get(type)?.has(m));

  for (const info of infos) {
    for (const p of info.pendingCalls) {
      let type: string | undefined = p.headType;
      if (p.headVar) {
        type = pkgVars.get(info.pkg)?.get(p.headVar);
        if (type === undefined && p.path.length === 0) {
          // Not a package var: an external package whose name differs from its import path.
          add(p.caller, `${p.headVar}.${p.method}`);
          continue;
        }
      }
      for (const field of p.path) {
        type = type ? fields.get(type)?.[field] : undefined;
        if (!type) break;
      }
      if (type) {
        const isProjectType = fields.has(type) || ifaces.has(type) || methodsByType.has(type);
        // External types (`pgxpool.Pool`) aren't modeled: keep `T.m` as written.
        if (!isProjectType || defines(type, p.method)) {
          add(p.caller, `${type}.${p.method}`);
          continue;
        }
        const embedded = Object.entries(fields.get(type) ?? {})
          .find(([k, v]) => k === lastSegment(v) && defines(v, p.method))?.[1];
        if (embedded) {
          add(p.caller, `${embedded}.${p.method}`);
          continue;
        }
      }
      // Unknown receiver type: link every other project type with that method.
      const all = owners.get(p.method) ?? [];
      if (all.length === 0 || all.length > MAX_GO_TARGETS + 1) {
        add(p.caller, p.method);
        continue;
      }
      const self = p.caller.endsWith(`.${p.method}`) ? p.caller.slice(0, -p.method.length - 1) : "";
      if (all.length - (methodsByType.get(self)?.has(p.method) ? 1 : 0) > MAX_GO_TARGETS) {
        add(p.caller, p.method);
        continue;
      }
      // No edge when the caller is the only owner: the receiver is then some external type.
      for (const t of all) if (t !== self) add(p.caller, `${t}.${p.method}`);
    }
  }
}
