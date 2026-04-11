import { parseSource, parseSourceAsync, getLanguageForFile } from "./parser.js";
import { getAdapter } from "./adapter-registry.js";
import type { CodeGraph, DefinesFact, CallsFact, ImportsFact, ExportsFact, ContainsFact } from "./types.js";

/** Extract a unified call graph from multiple source files */
export async function extractGraph(files: Array<{ path: string; content: string }>): Promise<CodeGraph> {
  const partials = await Promise.all(files.map((file) => extractFileGraph(file)));

  const defines: DefinesFact[] = [];
  const calls: CallsFact[] = [];
  const imports: ImportsFact[] = [];
  const exports: ExportsFact[] = [];
  const contains: ContainsFact[] = [];

  for (const p of partials) {
    defines.push(...p.defines);
    calls.push(...p.calls);
    imports.push(...p.imports);
    exports.push(...p.exports);
    contains.push(...p.contains);
  }

  return { defines, calls, imports, exports, contains };
}

async function extractFileGraph(file: { path: string; content: string }): Promise<CodeGraph> {
  const defines: DefinesFact[] = [];
  const calls: CallsFact[] = [];
  const imports: ImportsFact[] = [];
  const exports: ExportsFact[] = [];
  const contains: ContainsFact[] = [];
  const callSet = new Set<string>();

  const lang = getLanguageForFile(file.path);
  if (!lang) return { defines, calls, imports, exports, contains };

  const tree = parseSource(file.content, file.path)
    ?? await parseSourceAsync(file.content, file.path);
  if (!tree) return { defines, calls, imports, exports, contains };

  try {
    extractFromTree(tree, file.path, lang, defines, calls, imports, exports, contains, callSet);
  } finally {
    // web-tree-sitter (WASM) trees must be explicitly freed or WASM memory
    // grows monotonically. Native tree-sitter trees have no delete method
    // and are GC'd normally — guard with optional chaining.
    (tree as any).delete?.();
  }
  return { defines, calls, imports, exports, contains };
}

function extractFromTree(
  tree: any,
  filePath: string,
  lang: string,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  const adapter = getAdapter(lang);
  if (adapter) {
    const partial = adapter.extract(tree.rootNode, filePath);
    for (const d of partial.defines) defines.push(d);
    for (const c of partial.calls) {
      const key = `${c.caller}->${c.callee}`;
      if (!callSet.has(key)) { callSet.add(key); calls.push(c); }
    }
    for (const i of partial.imports) imports.push(i);
    for (const e of partial.exports) exports.push(e);
    for (const c of partial.contains ?? []) contains.push(c);
  } else if (lang === "clojure") {
    walkClojure(tree.rootNode, filePath, defines, calls, imports, exports, callSet);
  } else if (lang === "python") {
    const scopeStack: string[] = [];
    walkPython(tree.rootNode, filePath, scopeStack, defines, calls, imports, exports, contains, callSet);
  } else if (lang === "go") {
    walkGo(tree.rootNode, filePath, defines, calls, imports, exports, contains, callSet);
  } else {
    const scopeStack: string[] = [];
    walkNode(tree.rootNode, filePath, lang, scopeStack, defines, calls, imports, exports, contains, callSet);
  }
}

function walkNode(
  node: any,
  filePath: string,
  language: string,
  scopeStack: string[],
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  const type: string = node.type;

  switch (type) {
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        defines.push({ file: filePath, name, kind: "function", line: node.startPosition.row + 1 });
        scopeStack.push(name);
        walkChildren(node, filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
        scopeStack.pop();
        return; // already walked children
      }
      break;
    }

    case "method_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        defines.push({ file: filePath, name, kind: "method", line: node.startPosition.row + 1 });
        // Find enclosing class for contains relationship
        const className = findEnclosingClassName(node);
        if (className) {
          contains.push({ parent: className, child: name });
        }
        scopeStack.push(name);
        walkChildren(node, filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
        scopeStack.pop();
        return;
      }
      break;
    }

    case "class_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        defines.push({ file: filePath, name, kind: "class", line: node.startPosition.row + 1 });
        scopeStack.push(name);
        walkChildren(node, filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
        scopeStack.pop();
        return;
      }
      break;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      let foundArrow = false;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "variable_declarator") {
          const nameNode = child.childForFieldName("name");
          const valueNode = child.childForFieldName("value");
          if (nameNode && valueNode && valueNode.type === "arrow_function") {
            const name = nameNode.text;
            defines.push({ file: filePath, name, kind: "function", line: node.startPosition.row + 1 });
            scopeStack.push(name);
            walkChildren(valueNode, filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
            scopeStack.pop();
            foundArrow = true;
          } else if (valueNode) {
            walkChildren(child, filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
          }
        }
      }
      if (foundArrow) return;
      break;
    }

    case "call_expression": {
      const callee = resolveCallee(node);
      const caller = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
      if (callee && caller) {
        const key = `${caller}->${callee}`;
        if (!callSet.has(key)) {
          callSet.add(key);
          calls.push({ caller, callee });
        }
      }
      break; // fall through to walk children (nested calls)
    }

    case "import_statement": {
      const sourceNode = node.childForFieldName("source");
      const source = sourceNode ? extractStringContent(sourceNode) : null;
      if (source) {
        const importClause = node.children.find((c: any) => c.type === "import_clause");
        if (importClause) {
          extractImportNames(importClause, filePath, source, imports);
        }
      }
      return; // no need to walk deeper
    }

    case "export_statement": {
      // export function foo() {} or export class Foo {}
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "function_declaration" || child.type === "class_declaration") {
          const name = child.childForFieldName("name")?.text;
          if (name) {
            exports.push({ file: filePath, name });
          }
        }
        if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
          for (let j = 0; j < child.childCount; j++) {
            const decl = child.child(j);
            if (decl.type === "variable_declarator") {
              const name = decl.childForFieldName("name")?.text;
              if (name) {
                exports.push({ file: filePath, name });
              }
            }
          }
        }
        // export { foo, bar }
        if (child.type === "export_clause") {
          for (let j = 0; j < child.childCount; j++) {
            const spec = child.child(j);
            if (spec.type === "export_specifier") {
              const name = spec.childForFieldName("name")?.text;
              if (name) {
                exports.push({ file: filePath, name });
              }
            }
          }
        }
      }
      // Check for re-exports: export { foo } from './bar'
      const reSource = node.childForFieldName("source");
      if (reSource) {
        const source = extractStringContent(reSource);
        if (source) {
          const exportClause = node.children.find((c: any) => c.type === "export_clause");
          if (exportClause) {
            for (let j = 0; j < exportClause.childCount; j++) {
              const spec = exportClause.child(j);
              if (spec.type === "export_specifier") {
                const name = spec.childForFieldName("name")?.text;
                if (name) {
                  imports.push({ file: filePath, name, source });
                }
              }
            }
          }
        }
      }
      break; // fall through to walk children (may contain function_declaration etc.)
    }
  }

  walkChildren(node, filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
}

function walkChildren(
  node: any,
  filePath: string,
  language: string,
  scopeStack: string[],
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i), filePath, language, scopeStack, defines, calls, imports, exports, contains, callSet);
  }
}

/** Resolve the callee name from a call_expression node */
function resolveCallee(callNode: any): string | null {
  const fnNode = callNode.childForFieldName("function");
  if (!fnNode) return null;

  switch (fnNode.type) {
    case "identifier":
      return fnNode.text;

    case "member_expression": {
      // obj.method() → method, this.method() → method
      const property = fnNode.childForFieldName("property");
      return property?.text ?? null;
    }

    default:
      // Dynamic/compound calls (subscript, IIFE, logical-or, tagged template,
      // parenthesized expressions) can't be resolved statically. Emitting the
      // raw text like "(a || b)" or "() => 1" just produces noise in the
      // downstream facts, so drop them.
      return null;
  }
}

/** Find the enclosing class name for a method node */
function findEnclosingClassName(node: any): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "class_declaration" || current.type === "class") {
      return current.childForFieldName("name")?.text ?? null;
    }
    if (current.type === "class_body") {
      current = current.parent;
      continue;
    }
    current = current.parent;
  }
  return null;
}

/** Extract import names from an import_clause */
function extractImportNames(
  clause: any,
  filePath: string,
  source: string,
  imports: ImportsFact[],
): void {
  for (let i = 0; i < clause.childCount; i++) {
    const child = clause.child(i);

    // Default import: import foo from './bar'
    if (child.type === "identifier") {
      imports.push({ file: filePath, name: child.text, source });
    }

    // Named imports: import { foo, bar } from './baz'
    if (child.type === "named_imports") {
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j);
        if (spec.type === "import_specifier") {
          const name = spec.childForFieldName("name")?.text;
          if (name) {
            imports.push({ file: filePath, name, source });
          }
        }
      }
    }

    // Namespace import: import * as foo from './bar'
    if (child.type === "namespace_import") {
      const name = child.children.find((c: any) => c.type === "identifier")?.text;
      if (name) {
        imports.push({ file: filePath, name, source });
      }
    }
  }
}

/** Extract the string content from a string literal node (strip quotes) */
function extractStringContent(node: any): string | null {
  // String nodes have children: quote, string_fragment, quote
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "string_fragment") {
      return child.text;
    }
  }
  // Fallback: strip quotes/backticks from the full text
  const text = node.text;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("`") && text.endsWith("`"))) {
    return text.slice(1, -1);
  }
  return null;
}

// ── Python extraction ───────────────────────────────────────────────

function walkPython(
  node: any,
  filePath: string,
  scopeStack: string[],
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  const type: string = node.type;

  switch (type) {
    case "function_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        const enclosingClass = findPythonEnclosingClass(node);
        const kind = enclosingClass ? "method" : "function";
        defines.push({ file: filePath, name, kind, line: node.startPosition.row + 1 });
        if (enclosingClass) {
          contains.push({ parent: enclosingClass, child: name });
        }
        scopeStack.push(name);
        walkPythonChildren(node, filePath, scopeStack, defines, calls, imports, exports, contains, callSet);
        scopeStack.pop();
        return;
      }
      break;
    }

    case "class_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        defines.push({ file: filePath, name, kind: "class", line: node.startPosition.row + 1 });
        scopeStack.push(name);
        walkPythonChildren(node, filePath, scopeStack, defines, calls, imports, exports, contains, callSet);
        scopeStack.pop();
        return;
      }
      break;
    }

    case "decorated_definition": {
      // Falls through to walkPythonChildren to process the definition inside
      break;
    }

    case "call": {
      const callee = resolvePythonCallee(node);
      const caller = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
      if (callee && caller) {
        const key = `${caller}->${callee}`;
        if (!callSet.has(key)) {
          callSet.add(key);
          calls.push({ caller, callee });
        }
      }
      break;
    }

    case "import_statement": {
      // import os, sys
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "dotted_name") {
          imports.push({ file: filePath, name: child.text, source: child.text });
        }
        if (child.type === "aliased_import") {
          const dotted = child.childForFieldName("name");
          if (dotted) {
            const alias = child.childForFieldName("alias")?.text ?? dotted.text;
            imports.push({ file: filePath, name: alias, source: dotted.text });
          }
        }
      }
      return;
    }

    case "import_from_statement": {
      // from pathlib import Path
      const moduleNode = node.childForFieldName("module_name");
      const source = moduleNode?.text ?? "";
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        // Could be a single dotted_name or multiple via import list
        if (nameNode.type === "dotted_name" || nameNode.type === "identifier") {
          imports.push({ file: filePath, name: nameNode.text, source });
        }
      }
      // Handle multiple imports: from x import a, b, c
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "dotted_name" && child !== moduleNode && child !== nameNode) {
          imports.push({ file: filePath, name: child.text, source });
        }
        if (child.type === "aliased_import") {
          const importName = child.childForFieldName("name");
          const alias = child.childForFieldName("alias");
          if (importName) {
            imports.push({ file: filePath, name: alias?.text ?? importName.text, source });
          }
        }
      }
      return;
    }
  }

  walkPythonChildren(node, filePath, scopeStack, defines, calls, imports, exports, contains, callSet);
}

function walkPythonChildren(
  node: any,
  filePath: string,
  scopeStack: string[],
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  for (let i = 0; i < node.childCount; i++) {
    walkPython(node.child(i), filePath, scopeStack, defines, calls, imports, exports, contains, callSet);
  }
}

/** Resolve callee name from a Python call node */
function resolvePythonCallee(callNode: any): string | null {
  const fnNode = callNode.childForFieldName("function");
  if (!fnNode) return null;

  switch (fnNode.type) {
    case "identifier":
      return fnNode.text;

    case "attribute": {
      // obj.method() → method
      const attr = fnNode.childForFieldName("attribute");
      return attr?.text ?? null;
    }

    default:
      return null;
  }
}

/** Find the enclosing class name for a Python method node */
function findPythonEnclosingClass(node: any): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "class_definition") {
      return current.childForFieldName("name")?.text ?? null;
    }
    if (current.type === "block") {
      current = current.parent;
      continue;
    }
    current = current.parent;
  }
  return null;
}

// ── Go extraction ───────────────────────────────────────────────────

function walkGo(
  rootNode: any,
  filePath: string,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    const type: string = node.type;

    switch (type) {
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          defines.push({ file: filePath, name, kind: "function", line: node.startPosition.row + 1 });
          if (/^[A-Z]/.test(name)) {
            exports.push({ file: filePath, name });
          }
          extractGoCalls(node.childForFieldName("body"), name, calls, callSet);
        }
        break;
      }

      case "method_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          defines.push({ file: filePath, name, kind: "method", line: node.startPosition.row + 1 });
          // Extract receiver type for contains relationship
          const receiver = node.childForFieldName("receiver");
          const receiverType = extractGoReceiverType(receiver);
          if (receiverType) {
            contains.push({ parent: receiverType, child: name });
          }
          if (/^[A-Z]/.test(name)) {
            exports.push({ file: filePath, name });
          }
          extractGoCalls(node.childForFieldName("body"), name, calls, callSet);
        }
        break;
      }

      case "type_declaration": {
        // type Foo struct { ... } or type Foo interface { ... }
        for (let j = 0; j < node.childCount; j++) {
          const spec = node.child(j);
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name")?.text;
            const typeNode = spec.childForFieldName("type");
            if (name && typeNode) {
              const kind = typeNode.type === "interface_type" ? "interface" : "class";
              defines.push({ file: filePath, name, kind, line: node.startPosition.row + 1 });
              if (/^[A-Z]/.test(name)) {
                exports.push({ file: filePath, name });
              }
            }
          }
        }
        break;
      }

      case "import_declaration": {
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j);
          if (child.type === "import_spec_list") {
            for (let k = 0; k < child.childCount; k++) {
              const spec = child.child(k);
              if (spec.type === "import_spec") {
                const pathNode = spec.children.find((c: any) => c.type === "interpreted_string_literal");
                if (pathNode) {
                  const source = pathNode.text.slice(1, -1); // strip quotes
                  const name = source.split("/").pop() ?? source;
                  imports.push({ file: filePath, name, source });
                }
              }
            }
          }
          // Single import without parens
          if (child.type === "import_spec") {
            const pathNode = child.children.find((c: any) => c.type === "interpreted_string_literal");
            if (pathNode) {
              const source = pathNode.text.slice(1, -1);
              const name = source.split("/").pop() ?? source;
              imports.push({ file: filePath, name, source });
            }
          }
        }
        break;
      }
    }
  }
}

/** Recursively extract call_expression nodes from a Go function body */
function extractGoCalls(
  node: any,
  caller: string,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  if (!node) return;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === "call_expression") {
      const callee = resolveGoCallee(child);
      if (callee) {
        const key = `${caller}->${callee}`;
        if (!callSet.has(key)) {
          callSet.add(key);
          calls.push({ caller, callee });
        }
      }
    }

    extractGoCalls(child, caller, calls, callSet);
  }
}

/** Resolve callee name from a Go call_expression */
function resolveGoCallee(callNode: any): string | null {
  const fnNode = callNode.childForFieldName("function");
  if (!fnNode) return null;

  switch (fnNode.type) {
    case "identifier":
      return fnNode.text;

    case "selector_expression": {
      // pkg.Func() or obj.Method() → extract the field (right side)
      const field = fnNode.childForFieldName("field");
      return field?.text ?? null;
    }

    default:
      return null;
  }
}

/** Extract the receiver type name from a Go method receiver */
function extractGoReceiverType(receiver: any): string | null {
  if (!receiver) return null;
  // receiver is parameter_list: (a *Animal) or (a Animal)
  for (let i = 0; i < receiver.childCount; i++) {
    const param = receiver.child(i);
    if (param.type === "parameter_declaration") {
      const typeNode = param.childForFieldName("type");
      if (!typeNode) continue;
      // Could be pointer_type (*Animal) or type_identifier (Animal)
      if (typeNode.type === "pointer_type") {
        // First child after * is the type identifier
        for (let j = 0; j < typeNode.childCount; j++) {
          if (typeNode.child(j).type === "type_identifier") {
            return typeNode.child(j).text;
          }
        }
      }
      if (typeNode.type === "type_identifier") {
        return typeNode.text;
      }
    }
  }
  return null;
}

// ── Clojure extraction ──────────────────────────────────────────────

/** Get the text of the first sym_name child (direct or nested in sym_lit) */
function cljSymName(node: any): string | null {
  if (node.type === "sym_name") return node.text;
  if (node.type === "sym_lit") {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i).type === "sym_name") return node.child(i).text;
    }
  }
  return null;
}

/** Extract ns form: (ns foo.bar (:require [baz.qux :as q] [x.y :refer [z]])) */
function cljExtractNs(
  listNode: any,
  filePath: string,
  imports: ImportsFact[],
): string | null {
  let symIdx = -1;
  for (let i = 0; i < listNode.childCount; i++) {
    if (listNode.child(i).type === "sym_lit") { symIdx = i; break; }
  }
  if (symIdx < 0) return null;

  const head = cljSymName(listNode.child(symIdx));
  if (head !== "ns") return null;

  // Namespace name is next sym_lit
  let nsName: string | null = null;
  for (let i = symIdx + 1; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child.type === "sym_lit") {
      nsName = cljSymName(child);
      break;
    }
  }

  // Find (:require ...) forms
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child.type !== "list_lit") continue;

    // Check if first element is :require keyword
    for (let j = 0; j < child.childCount; j++) {
      const kwd = child.child(j);
      if (kwd.type === "kwd_lit") {
        const kwdName = kwd.children?.find((c: any) => c.type === "kwd_name")?.text;
        if (kwdName === "require") {
          // Extract required namespaces from vec_lit children
          for (let k = j + 1; k < child.childCount; k++) {
            const vec = child.child(k);
            if (vec.type === "vec_lit") {
              // First sym_lit in vector is the required namespace
              for (let l = 0; l < vec.childCount; l++) {
                if (vec.child(l).type === "sym_lit") {
                  const reqNs = cljSymName(vec.child(l));
                  if (reqNs) {
                    imports.push({ file: filePath, name: reqNs, source: reqNs });
                  }
                  break;
                }
              }
            }
          }
        }
        break;
      }
    }
  }

  return nsName;
}

/**
 * If a list_lit's first significant child is a sym_lit, return its name +
 * child index; otherwise return null. This is deliberately stricter than
 * "first sym_lit anywhere" — for keyword-first / map-first / set-first /
 * list-first lists (e.g. `(:k m)`, `(#{1 2} x)`, `({:a 1} :a)`,
 * `((comp f g) x)`) there is no symbolic head and we must not treat the
 * first *later* sym_lit as a callee (which would create bogus edges for
 * locals like `m`, `x`, `:a`).
 */
function cljListHead(listNode: any): { name: string; symIdx: number } | null {
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!CLJ_FORM_TYPES.has(child.type)) continue;
    if (child.type !== "sym_lit") return null;
    const name = cljSymName(child);
    return name ? { name, symIdx: i } : null;
  }
  return null;
}

/** First sym_lit name appearing strictly after a given child index. */
function cljNextSymNameAfter(listNode: any, afterIdx: number): string | null {
  for (let i = afterIdx + 1; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child.type === "sym_lit") {
      const name = cljSymName(child);
      if (name) return name;
    }
  }
  return null;
}

/** Form-bearing child types (skip parens, whitespace, comments, metadata markers). */
const CLJ_FORM_TYPES = new Set([
  "sym_lit", "kwd_lit", "str_lit", "num_lit", "char_lit",
  "nil_lit", "bool_lit", "list_lit", "map_lit", "vec_lit", "set_lit",
  "regex_lit", "anon_fn_lit", "tagged_or_ctor_lit", "quoting_lit",
  "syn_quoting_lit", "derefing_lit", "unquoting_lit",
  "unquote_splicing_lit", "var_quoting_lit", "read_cond_lit",
  "splicing_read_cond_lit", "ns_map_lit",
]);

/**
 * If `listNode` has the shape `(name [args] body...)` — i.e. its first two
 * significant children are a sym_lit followed by a vec_lit — return the
 * method name. Used to recognize protocol method implementations inside
 * defrecord / deftype / extend-type / extend-protocol bodies, and method
 * signatures inside defprotocol bodies.
 */
function cljMethodImplName(listNode: any): string | null {
  if (listNode.type !== "list_lit") return null;
  let name: string | null = null;
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!CLJ_FORM_TYPES.has(child.type)) continue;
    if (name === null) {
      if (child.type !== "sym_lit") return null;
      name = cljSymName(child);
      if (!name) return null;
      // A head that's a known special form (defn, let, etc.) is never a
      // protocol method impl — bail so we don't misclassify stray nested defs.
      if (CLJ_SPECIAL_FORMS.has(name)) return null;
    } else {
      return child.type === "vec_lit" ? name : null;
    }
  }
  return null;
}

/**
 * Walk child list_lits of a defrecord / deftype / extend-type /
 * extend-protocol form, extracting call edges from each method impl body
 * using the method name as the caller.
 */
function cljWalkDispatchMethods(
  parentList: any,
  inFileDefns: Set<string>,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  for (let i = 0; i < parentList.childCount; i++) {
    const child = parentList.child(i);
    if (child.type !== "list_lit") continue;
    const methodName = cljMethodImplName(child);
    if (methodName) {
      cljExtractCalls(child, methodName, inFileDefns, calls, callSet);
    }
  }
}

/**
 * Top-level forms that walkClojure recognizes by name. Any top-level
 * list_lit whose head is NOT in this set gets walked as "file-level init"
 * — its calls are attributed to the namespace name, so patterns like
 *   (use-fixtures :each my-fixture)
 *   (def cfg (load-config "x.edn"))
 * still produce edges instead of silently dropping.
 */
const CLJ_RECOGNIZED_TOPLEVEL = new Set([
  "ns", "defn", "defn-", "defmulti", "defmethod",
  "defprotocol", "defrecord", "deftype", "definterface",
  "extend-type", "extend-protocol", "deftest",
]);

/** Walk a Clojure AST and extract defines, calls, imports */
function walkClojure(
  rootNode: any,
  filePath: string,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  callSet: Set<string>,
): void {
  let nsName: string | null = null;
  const definesBeforePhase1 = defines.length;

  // ── Phase 1: collect top-level definitions ────────────────────────
  // In addition to defn/defn-, we also register defmulti, defprotocol
  // (and its declared methods), defrecord, deftype, definterface,
  // deftest. This ensures the dead-code analysis sees them as known
  // functions/classes, and the downstream Prolog facts are complete.
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "list_lit") continue;

    // ns form — harvest requires and capture the namespace name for use
    // as the top-level caller in phase 2.
    const ns = cljExtractNs(child, filePath, imports);
    if (ns) {
      nsName = ns;
      continue;
    }

    const head = cljListHead(child);
    if (!head) continue;
    const line = child.startPosition.row + 1;

    switch (head.name) {
      case "defn":
      case "defn-": {
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (!name) break;
        defines.push({ file: filePath, name, kind: "function", line });
        if (head.name === "defn") exports.push({ file: filePath, name });
        break;
      }

      case "defmulti": {
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (!name) break;
        defines.push({ file: filePath, name, kind: "function", line });
        exports.push({ file: filePath, name });
        break;
      }

      case "defprotocol":
      case "definterface": {
        // Both forms share a shape: (head Name (m1 [args] doc?) (m2 ...) ...)
        const ifaceName = cljNextSymNameAfter(child, head.symIdx);
        if (ifaceName) {
          defines.push({ file: filePath, name: ifaceName, kind: "class", line });
          exports.push({ file: filePath, name: ifaceName });
        }
        for (let j = 0; j < child.childCount; j++) {
          const sub = child.child(j);
          if (sub.type !== "list_lit") continue;
          const methodName = cljMethodImplName(sub);
          if (methodName) {
            defines.push({
              file: filePath, name: methodName, kind: "function",
              line: sub.startPosition.row + 1,
            });
            exports.push({ file: filePath, name: methodName });
          }
        }
        break;
      }

      case "defrecord":
      case "deftype": {
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (!name) break;
        defines.push({ file: filePath, name, kind: "class", line });
        exports.push({ file: filePath, name });
        break;
      }

      case "deftest": {
        // (deftest test-name body...) — register as an exported function
        // so it shows up as an entry point and its body is walked for
        // calls to helpers / subject code.
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (!name) break;
        defines.push({ file: filePath, name, kind: "function", line });
        exports.push({ file: filePath, name });
        break;
      }
    }
  }

  // Snapshot the set of names defined in *this file* during phase 1.
  // Phase 2's cljExtractCalls uses this to recognize in-file references:
  // whenever it encounters a sym_lit whose name matches one of these,
  // it emits a reference edge. This covers user-defined HOFs, map-value
  // registrations (`{:home home-handler}`), `(def h my-fn)`, and similar
  // patterns where a fn is passed by value rather than called directly.
  const inFileDefns = new Set<string>();
  for (let k = definesBeforePhase1; k < defines.length; k++) {
    inFileDefns.add(defines[k].name);
  }

  // Synthetic caller for top-level side-effecting forms. If the file has
  // no ns declaration, fall back to the file path — it's still a unique
  // identifier that downstream analyses can treat as "always live".
  const topLevelCaller = nsName ?? `<toplevel:${filePath}>`;

  // ── Phase 2: walk bodies for call edges ──────────────────────────
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "list_lit") continue;

    const head = cljListHead(child);
    if (!head) {
      // Non-symbolic head (keyword-first, map-first, etc.) at top level.
      // Still walk it as file-level init — unusual but possible.
      cljExtractCalls(child, topLevelCaller, inFileDefns, calls, callSet);
      continue;
    }

    switch (head.name) {
      case "ns":
        // Already handled in phase 1.
        break;

      case "defn":
      case "defn-":
      case "deftest": {
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (name) cljExtractCalls(child, name, inFileDefns, calls, callSet);
        break;
      }

      case "defmulti": {
        // No body — just the dispatch fn. Walk it so e.g.
        //   (defmulti route :path)
        // registers a reference to `:path`-like dispatch fns if they're
        // named. Attribute to the multi name.
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (name) cljExtractCalls(child, name, inFileDefns, calls, callSet);
        break;
      }

      case "defmethod": {
        // (defmethod multi-name dispatch-val [args] body). Attribute calls
        // in the body to the multi name, so a private helper invoked here
        // is recorded as "called by" the multi and won't look dead.
        const multiName = cljNextSymNameAfter(child, head.symIdx);
        if (multiName) cljExtractCalls(child, multiName, inFileDefns, calls, callSet);
        break;
      }

      case "defrecord":
      case "deftype":
      case "extend-type":
      case "extend-protocol": {
        cljWalkDispatchMethods(child, inFileDefns, calls, callSet);
        break;
      }

      default: {
        // Unrecognized top-level form — walk as file-level init with the
        // ns name as caller. Catches use-fixtures, (def x (compute)),
        // (require '[...]), raw println calls, etc.
        if (!CLJ_RECOGNIZED_TOPLEVEL.has(head.name)) {
          cljExtractCalls(child, topLevelCaller, inFileDefns, calls, callSet);
        }
        break;
      }
    }
  }
}

/**
 * Clojure special forms and core macros that look like function calls in
 * the AST (first position of a list_lit) but are not real call edges.
 * Filtering these removes ~80% of the noise from cljExtractCalls output.
 */
const CLJ_SPECIAL_FORMS = new Set([
  // Core special forms
  "def", "do", "fn", "fn*", "if", "let", "let*", "letfn", "letfn*",
  "loop", "loop*", "monitor-enter", "monitor-exit", "new", "quote",
  "recur", "set!", "throw", "try", "catch", "finally", "var",
  // Definition macros
  "defn", "defn-", "defmacro", "defmulti", "defmethod", "defprotocol",
  "defrecord", "deftype", "definterface", "defonce", "defstruct",
  "extend-type", "extend-protocol", "extend", "reify",
  // Control-flow / binding macros
  "when", "when-not", "when-let", "when-some", "when-first",
  "if-let", "if-some", "if-not",
  "cond", "condp", "case",
  "and", "or", "not",
  "do", "doto", "dotimes", "doseq", "dorun", "doall",
  "for", "while",
  // Threading macros
  "->", "->>", "as->", "some->", "some->>", "cond->", "cond->>",
  // Misc
  "declare", "comment", "assert", "lazy-seq", "delay", "force",
  "binding", "locking", "sync", "with-open", "with-local-vars",
  "with-meta", "with-redefs", "with-redefs-fn",
]);

/**
 * HOFs whose first argument is the function being invoked. For
 * `(mapv f xs)` / `(filter pred xs)` / `(reduce f init xs)` / etc., only
 * the first sym_lit arg is a fn reference; subsequent sym_lits are
 * collections or accumulator values and emitting edges for them just adds
 * noise. `partial` belongs here too (`(partial f bound-arg)`).
 */
const CLJ_HOFS_ARG1 = new Set([
  "map", "mapv", "mapcat", "pmap", "map-indexed",
  "filter", "filterv", "remove",
  "reduce", "reduce-kv", "reductions",
  "keep", "keep-indexed",
  "apply", "partial",
  "every?", "not-every?", "some", "not-any?",
  "sort-by", "group-by", "partition-by",
  "take-while", "drop-while", "split-with",
  "iterate", "repeatedly",
  "memoize", "fnil",
  "run!", "trampoline", "complement",
]);

/**
 * HOFs where every argument is a function (composed/combined). `(comp f g h)`
 * and `(juxt f g h)` both invoke every argument. `use-fixtures` belongs
 * here too — `(use-fixtures :each f1 f2 ...)` registers each fn as a
 * fixture. The leading `:each`/`:once` keyword is skipped by the
 * sym_lit-only filter.
 */
const CLJ_HOFS_ALL_ARGS = new Set([
  "comp", "juxt", "use-fixtures",
]);

/**
 * Threading-style macros whose non-value arguments can include bare
 * sym_lit function references. The value is the number of *initial*
 * forms (after the head) that are the threaded value / binding name and
 * must be skipped. Subsequent bare sym_lit args are emitted as fn refs.
 *
 *   ->, ->>, some->, some->> — `(-> x foo bar)` : skip 1 (the value)
 *   cond->, cond->>          — `(cond-> x t1 f1 t2 f2)` : skip 1. Tests
 *                              usually aren't bare syms, forms often are.
 *   doto                     — `(doto obj m1 m2)` : skip 1 (the object)
 *   as->                     — `(as-> init $ f1 f2)` : skip 2 (value + binding)
 */
const CLJ_THREADING_MACROS = new Map<string, number>([
  ["->", 1], ["->>", 1], ["some->", 1], ["some->>", 1],
  ["cond->", 1], ["cond->>", 1], ["doto", 1],
  ["as->", 2],
]);

/** Child types we recurse into when hunting for call sites. */
const CLJ_RECURSE_TYPES = new Set([
  "list_lit", "vec_lit", "map_lit", "set_lit",
  // Reader macros that wrap executable forms. Without these, calls inside
  //   #(foo %)        — anon fn
  //   #?(:clj (foo))  — reader conditional
  //   @(promise-fn)   — deref of a call
  //   #:ns{:k (foo)}  — ns-map with fn values
  // are invisible to the call-graph extractor.
  "anon_fn_lit", "read_cond_lit", "splicing_read_cond_lit", "ns_map_lit",
  "derefing_lit", "syn_quoting_lit", "unquoting_lit",
  "unquote_splicing_lit", "tagged_or_ctor_lit",
]);

/**
 * Process a single list-like form (list_lit or anon_fn_lit) as a call
 * site: emit its head as a callee, then apply HOF / threading-macro
 * reference rules to its arguments.
 */
function cljProcessCallSite(
  listLike: any,
  enclosingFn: string,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  const emit = (calleeRaw: string): void => {
    const callee = calleeRaw.includes("/") ? calleeRaw.split("/").pop()! : calleeRaw;
    if (!callee || callee === enclosingFn) return;
    if (CLJ_SPECIAL_FORMS.has(callee)) return;
    const key = `${enclosingFn}->${callee}`;
    if (callSet.has(key)) return;
    callSet.add(key);
    calls.push({ caller: enclosingFn, callee });
  };

  const head = cljListHead(listLike);
  if (!head) return;
  emit(head.name);

  const normalizedHead = head.name.includes("/")
    ? head.name.split("/").pop()!
    : head.name;

  if (CLJ_HOFS_ARG1.has(normalizedHead)) {
    // Emit only the first form-bearing argument if it's a sym_lit.
    // Stopping after the first form avoids edges for collection args
    // like `coll` in `(filter pred coll)`.
    for (let k = head.symIdx + 1; k < listLike.childCount; k++) {
      const arg = listLike.child(k);
      if (!CLJ_FORM_TYPES.has(arg.type)) continue;
      if (arg.type === "sym_lit") {
        const argName = cljSymName(arg);
        if (argName) emit(argName);
      }
      break;
    }
  } else if (CLJ_HOFS_ALL_ARGS.has(normalizedHead)) {
    // Every sym_lit argument is a function reference.
    for (let k = head.symIdx + 1; k < listLike.childCount; k++) {
      const arg = listLike.child(k);
      if (arg.type !== "sym_lit") continue;
      const argName = cljSymName(arg);
      if (argName) emit(argName);
    }
  } else {
    const skipCount = CLJ_THREADING_MACROS.get(normalizedHead);
    if (skipCount !== undefined) {
      // Skip the first `skipCount` forms (value and optionally binding name),
      // then emit every bare sym_lit arg as a fn reference.
      let skipped = 0;
      for (let k = head.symIdx + 1; k < listLike.childCount; k++) {
        const arg = listLike.child(k);
        if (!CLJ_FORM_TYPES.has(arg.type)) continue;
        if (skipped < skipCount) {
          skipped++;
          continue;
        }
        if (arg.type === "sym_lit") {
          const argName = cljSymName(arg);
          if (argName) emit(argName);
        }
      }
    }
  }
}

/**
 * Recursively extract function calls from a Clojure form. Treats the
 * passed node itself as a call site if it's list-like, then recurses
 * into children — recursion handles every nested list_lit / anon_fn_lit
 * as its own call site via the same top-of-function check.
 *
 * Every sym_lit encountered at any depth is also checked against
 * `inFileDefns`: if its name matches a definition in the current file,
 * an edge is emitted. This covers in-file references that aren't at
 * list-head position — e.g. fns passed to user-defined HOFs, fn values
 * in map literals, `(def h my-fn)`, and registration-style calls like
 * `(reg-event-fx :k handler)`.
 */
function cljExtractCalls(
  node: any,
  enclosingFn: string,
  inFileDefns: Set<string>,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  if (node.type === "list_lit" || node.type === "anon_fn_lit") {
    cljProcessCallSite(node, enclosingFn, calls, callSet);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "sym_lit") {
      const name = cljSymName(child);
      if (name) {
        const bare = name.includes("/") ? name.split("/").pop()! : name;
        if (bare && bare !== enclosingFn && inFileDefns.has(bare)) {
          const key = `${enclosingFn}->${bare}`;
          if (!callSet.has(key)) {
            callSet.add(key);
            calls.push({ caller: enclosingFn, callee: bare });
          }
        }
      }
    }
    if (CLJ_RECURSE_TYPES.has(child.type)) {
      cljExtractCalls(child, enclosingFn, inFileDefns, calls, callSet);
    }
  }
}
