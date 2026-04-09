import { parseSource, parseSourceAsync, getLanguageForFile } from "./parser.js";
import type { CodeGraph, DefinesFact, CallsFact, ImportsFact, ExportsFact, ContainsFact } from "./types.js";

/** Extract a unified call graph from multiple source files */
export async function extractGraph(files: Array<{ path: string; content: string }>): Promise<CodeGraph> {
  const defines: DefinesFact[] = [];
  const calls: CallsFact[] = [];
  const imports: ImportsFact[] = [];
  const exports: ExportsFact[] = [];
  const contains: ContainsFact[] = [];

  const callSet = new Set<string>(); // deduplicate caller→callee

  for (const file of files) {
    const lang = getLanguageForFile(file.path);
    if (!lang) continue;

    // Try sync first (CJS grammars), fall back to async (ESM grammars)
    const tree = parseSource(file.content, file.path)
      ?? await parseSourceAsync(file.content, file.path);
    if (!tree) continue;

    if (lang === "clojure") {
      walkClojure(tree.rootNode, file.path, defines, calls, imports, exports, callSet);
    } else if (lang === "python") {
      const scopeStack: string[] = [];
      walkPython(tree.rootNode, file.path, scopeStack, defines, calls, imports, exports, contains, callSet);
    } else if (lang === "go") {
      walkGo(tree.rootNode, file.path, defines, calls, imports, exports, contains, callSet);
    } else {
      const scopeStack: string[] = [];
      walkNode(tree.rootNode, file.path, lang, scopeStack, defines, calls, imports, exports, contains, callSet);
    }
  }

  return { defines, calls, imports, exports, contains };
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
      }
      break; // fall through to walk children
    }

    case "lexical_declaration":
    case "variable_declaration": {
      // Look for arrow functions: const foo = () => { ... }
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
            return; // already walked
          }
        }
      }
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

    // Dynamic calls like obj[x]() — not statically resolvable
    case "subscript_expression":
      return null;

    default:
      // For other cases (e.g., IIFE, template literals), try the text if short
      return fnNode.text.length <= 50 ? fnNode.text : null;
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
  // Fallback: strip quotes from the full text
  const text = node.text;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
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
        const kind = findPythonEnclosingClass(node) ? "method" : "function";
        defines.push({ file: filePath, name, kind, line: node.startPosition.row + 1 });
        const enclosingClass = findPythonEnclosingClass(node);
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
      // Walk into the actual definition inside the decorator
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
      return fnNode.text.length <= 50 ? fnNode.text : null;
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
      return fnNode.text.length <= 50 ? fnNode.text : null;
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

/** Check if a list_lit is a (defn ...) or (defn- ...) form */
function cljDefnName(listNode: any): { name: string; private: boolean } | null {
  // First child after ( should be sym_lit with sym_name "defn" or "defn-"
  let symIdx = -1;
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child.type === "sym_lit") {
      symIdx = i;
      break;
    }
  }
  if (symIdx < 0) return null;

  const head = cljSymName(listNode.child(symIdx));
  if (head !== "defn" && head !== "defn-") return null;

  // Next sym_lit is the function name
  for (let i = symIdx + 1; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child.type === "sym_lit") {
      const name = cljSymName(child);
      if (name) return { name, private: head === "defn-" };
    }
  }
  return null;
}

/** Extract ns form: (ns foo.bar (:require [baz.qux :as q] [x.y :refer [z]])) */
function cljExtractNs(
  listNode: any,
  filePath: string,
  imports: ImportsFact[],
  exports: ExportsFact[],
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
  const defnNames = new Set<string>(); // track defined function names

  // First pass: collect top-level forms
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "list_lit") continue;

    // Check for ns form
    const nsName = cljExtractNs(child, filePath, imports, exports);
    if (nsName) continue;

    // Check for defn/defn-
    const defn = cljDefnName(child);
    if (defn) {
      defines.push({
        file: filePath,
        name: defn.name,
        kind: "function",
        line: child.startPosition.row + 1,
      });
      defnNames.add(defn.name);
      if (!defn.private) {
        exports.push({ file: filePath, name: defn.name });
      }
    }
  }

  // Second pass: extract calls within each defn body
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "list_lit") continue;

    const defn = cljDefnName(child);
    if (!defn) continue;

    // Walk the body looking for call sites (list_lit starting with sym_lit)
    cljExtractCalls(child, defn.name, calls, callSet, defnNames);
  }
}

/** Recursively extract function calls from a Clojure form */
function cljExtractCalls(
  node: any,
  enclosingFn: string,
  calls: CallsFact[],
  callSet: Set<string>,
  skipSelf: Set<string> | null,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "list_lit") {
      // First sym_lit child is the function being called
      for (let j = 0; j < child.childCount; j++) {
        const maybeCall = child.child(j);
        if (maybeCall.type === "sym_lit") {
          let callee = cljSymName(maybeCall);
          if (callee && callee !== enclosingFn) {
            // Strip namespace qualifier: db/query → query
            if (callee.includes("/")) {
              callee = callee.split("/").pop()!;
            }
            const key = `${enclosingFn}->${callee}`;
            if (!callSet.has(key)) {
              callSet.add(key);
              calls.push({ caller: enclosingFn, callee });
            }
          }
          break;
        }
      }
      // Recurse into nested forms
      cljExtractCalls(child, enclosingFn, calls, callSet, skipSelf);
    }
  }
}
