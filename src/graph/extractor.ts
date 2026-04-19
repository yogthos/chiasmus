import { parseSource, parseSourceAsync, getLanguageForFile } from "./parser.js";
import { getAdapter } from "./adapter-registry.js";
import { checkFileCache, saveFileCache, type CacheOptions } from "./cache.js";
import type { CodeGraph, DefinesFact, CallsFact, ImportsFact, ExportsFact, ContainsFact, FileNode, FileTypeInfo, PendingCall } from "./types.js";
import { extractClassFields, extractSimpleTypeName } from "./type-env.js";
import { buildClassFieldRegistry, resolveCallsWithRegistry } from "./resolve-calls.js";
import { loadTsconfigAliases, EMPTY_TSCONFIG_ALIASES, type TsconfigAliasMap } from "./tsconfig-aliases.js";
import { buildSuffixIndex, suffixResolveImport, EMPTY_SUFFIX_INDEX, type SuffixIndex } from "./suffix-index.js";
import { dirname as pathDirname, relative as pathRelative, resolve as pathResolve } from "node:path";

export interface ExtractOptions {
  /**
   * When supplied, read/write per-file extraction results from disk. The
   * cache is keyed on content+path, so unchanged files skip parsing.
   */
  cache?: CacheOptions;
  /**
   * Repository root (absolute) used to load tsconfig.json path aliases
   * and to compute repo-relative paths in resolved imports. When omitted,
   * the longest common ancestor of the batch file paths is used.
   */
  repoPath?: string;
}

/**
 * Longest common ancestor of the given absolute paths, used as a best-guess
 * repo root when the caller does not supply one. Returns "/" (root) when
 * the paths share no common prefix; returns the first path's directory
 * when a single file is given.
 */
function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return "/";
  const parts = paths.map((p) => p.split("/").filter(Boolean));
  if (parts.length === 1) {
    const p = parts[0];
    p.pop();
    return "/" + p.join("/");
  }
  let i = 0;
  const min = Math.min(...parts.map((p) => p.length));
  while (i < min) {
    const seg = parts[0][i];
    if (!parts.every((p) => p[i] === seg)) break;
    i++;
  }
  const common = parts[0].slice(0, i);
  if (common.length === 0) return "/";
  return "/" + common.join("/");
}

/**
 * Resolve each ImportsFact.source to a canonical file path (repo-relative)
 * using tsconfig aliases + a suffix index over the batch files. Mutates
 * the graph in place.
 */
function resolveImportsInPlace(
  graph: CodeGraph,
  repoPath: string,
  aliases: TsconfigAliasMap,
  suffix: SuffixIndex,
): void {
  if (!aliases.hasAliases && suffix.size === 0) return;
  // Cache keyed on (sourceDir + source) — the resolution depends on both
  // because "./foo" means different things from different directories.
  const cache = new Map<string, string | null>();
  for (const imp of graph.imports) {
    if (imp.resolved) continue;
    const source = imp.source;
    if (!source) continue;
    const srcDir = pathDirname(imp.file);
    const cacheKey = `${srcDir}\0${source}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      if (cached) imp.resolved = cached;
      continue;
    }
    const isRelative = source.startsWith("./") || source.startsWith("../");
    let resolved: string | null = null;

    if (isRelative) {
      // Relative imports must resolve EXACTLY from the importing file's
      // directory. If the intended target isn't in the batch, returning
      // null beats silently matching an unrelated same-basename file
      // somewhere else.
      const abs = pathResolve(srcDir, source);
      const rel = pathRelative(repoPath, abs).replace(/\\/g, "/");
      if (!rel.startsWith("..")) {
        resolved = exactLookup(rel, suffix);
      }
    } else {
      // Aliased or bare: try alias rewrite → suffix resolver. The shorter-
      // suffix fallback is OK here because bare/aliased specifiers don't
      // carry directory context.
      const aliased = aliases.rewrite(source);
      if (aliased !== null) {
        resolved = suffixResolveImport(source, aliased, suffix);
      }
    }
    cache.set(cacheKey, resolved);
    if (resolved) imp.resolved = resolved;
  }
}

/**
 * Exact lookup for a repo-relative path (no extension) against the suffix
 * index. Tries each candidate TS/JS extension and the `/index.ext` form.
 * Never falls back to shorter suffixes.
 */
function exactLookup(rel: string, suffix: SuffixIndex): string | null {
  const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
  const stripped = rel.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, "");
  for (const ext of EXTS) {
    const k = stripped + ext;
    const hit = suffix.get(k) ?? suffix.getInsensitive(k);
    if (hit) return hit;
  }
  for (const ext of EXTS) {
    const k = stripped + "/index" + ext;
    const hit = suffix.get(k) ?? suffix.getInsensitive(k);
    if (hit) return hit;
  }
  return null;
}

/** Extract a unified call graph from multiple source files */
export async function extractGraph(
  files: Array<{ path: string; content: string }>,
  opts: ExtractOptions = {},
): Promise<CodeGraph> {
  let cached: Array<{ path: string; graph: CodeGraph }> = [];
  let toExtract: Array<{ path: string; content: string }> = files;

  if (opts.cache) {
    const r = await checkFileCache(files, opts.cache);
    cached = r.hits;
    toExtract = r.misses;
  }

  const fresh = await Promise.all(
    toExtract.map(async (file) => ({ path: file.path, content: file.content, graph: await extractFileGraph(file) })),
  );

  if (opts.cache && fresh.length > 0) {
    await saveFileCache(
      fresh.map(({ path, content, graph }) => ({ path, content, graph })),
      opts.cache,
    );
  }

  const defines: DefinesFact[] = [];
  const calls: CallsFact[] = [];
  const imports: ImportsFact[] = [];
  const exports: ExportsFact[] = [];
  const contains: ContainsFact[] = [];
  const fileNodes = new Map<string, FileNode>();
  const allTypeInfo: FileTypeInfo[] = [];

  for (const { graph: p } of [...cached, ...fresh]) {
    defines.push(...p.defines);
    calls.push(...p.calls);
    imports.push(...p.imports);
    exports.push(...p.exports);
    contains.push(...p.contains);
    for (const fn of p.files ?? []) if (!fileNodes.has(fn.path)) fileNodes.set(fn.path, fn);
    if (p._typeInfo) allTypeInfo.push(...p._typeInfo);
  }

  const merged: CodeGraph = { defines, calls, imports, exports, contains, files: [...fileNodes.values()] };

  // Project-wide qualified-name resolution. Runs only when at least one
  // file produced type info (currently TS/JS). Mutates `calls` in place
  // to fill `calleeQN` for resolved receiver chains.
  if (allTypeInfo.length > 0) {
    merged._typeInfo = allTypeInfo;
    const registry = buildClassFieldRegistry(allTypeInfo);
    resolveCallsWithRegistry(merged, registry);
  }

  // Import resolution: rewrite through tsconfig aliases and the suffix
  // index to produce ImportsFact.resolved pointing at the canonical
  // in-batch file path (repo-relative).
  const repoPath = opts.repoPath ?? commonAncestor(files.map((f) => f.path));
  const aliases = opts.repoPath ? loadTsconfigAliases(opts.repoPath) : EMPTY_TSCONFIG_ALIASES;
  const suffix = files.length > 0
    ? buildSuffixIndex(repoPath, "", files.map((f) => f.path))
    : EMPTY_SUFFIX_INDEX;
  resolveImportsInPlace(merged, repoPath, aliases, suffix);

  return merged;
}

async function extractFileGraph(file: { path: string; content: string }): Promise<CodeGraph> {
  const defines: DefinesFact[] = [];
  const calls: CallsFact[] = [];
  const imports: ImportsFact[] = [];
  const exports: ExportsFact[] = [];
  const contains: ContainsFact[] = [];
  const files: FileNode[] = [];
  const callSet = new Set<string>();

  const lang = getLanguageForFile(file.path);
  if (!lang) return { defines, calls, imports, exports, contains, files };

  const fileNode: FileNode = {
    path: file.path,
    language: lang,
    tokenEstimate: Math.ceil(file.content.length / 3.5),
    lineCount: countLines(file.content),
  };
  files.push(fileNode);

  const tree = parseSource(file.content, file.path)
    ?? await parseSourceAsync(file.content, file.path);
  if (!tree) return { defines, calls, imports, exports, contains, files };

  let typeInfo: FileTypeInfo | undefined;
  try {
    const doc = extractFileDoc(tree.rootNode, lang);
    if (doc) fileNode.fileDoc = doc;
    extractFromTree(tree, file.path, lang, defines, calls, imports, exports, contains, callSet);
    // Collect receiver-chain + class-field type info for TS/JS. Lets a
    // later project-wide pass fill `calleeQN` on matching CallsFacts.
    // Wrap in try/catch so an unexpected AST shape never sinks the main
    // graph extraction — QN is best-effort, the rest of the graph isn't.
    if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
      try {
        typeInfo = collectTypeInfo(tree.rootNode, file.path);
      } catch {
        typeInfo = undefined;
      }
    }
  } finally {
    // web-tree-sitter (WASM) trees must be explicitly freed or WASM memory
    // grows monotonically. Native tree-sitter trees have no delete method
    // and are GC'd normally — guard with optional chaining.
    (tree as any).delete?.();
  }
  const result: CodeGraph = { defines, calls, imports, exports, contains, files };
  if (typeInfo) result._typeInfo = [typeInfo];
  return result;
}

/**
 * Count newline-terminated lines, plus a trailing line if the file doesn't
 * end with `\n`. Empty file counts as 0.
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  if (content.charCodeAt(content.length - 1) !== 10) n++;
  return n;
}

/**
 * Leading file-level documentation. The goal is to hand an LLM something
 * that actually describes the file — not license headers, shebangs, or
 * emacs modelines. Each language picks only the *idiomatic* doc shape:
 *
 *   TS / JS  — first `/** ... *\/` JSDoc block. Single-line `//` comments
 *              are almost always SPDX/license/shebang noise and are
 *              rejected even when they look like prose.
 *   Python   — module-level `"""..."""` docstring. `#` comments are
 *              rejected (too often shebangs or coding declarations).
 *   Go       — any leading `//` comment block, per the Go package-doc
 *              convention (`// Package foo does X.`).
 *   Clojure  — no leading `;` comments captured; the idiomatic spot is
 *              the ns docstring, which we don't parse yet.
 *
 * Result is collapsed to a single paragraph and truncated to DOC_MAX_LEN.
 */
const DOC_MAX_LEN = 240;

function extractFileDoc(root: any, lang: string): string | undefined {
  if (lang === "python") {
    return extractPythonModuleDocstring(root);
  }
  if (lang === "clojure") {
    return undefined;
  }

  const lines: string[] = [];
  let sawDocShape = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (!child) break;
    if (!isCommentNode(child.type)) break;
    if (!isDocShape(child.text, lang)) {
      // Stop at the first non-doc comment: license/SPDX headers usually
      // sit before any real doc, so continuing the walk would re-capture
      // the noise we rejected here.
      break;
    }
    sawDocShape = true;
    const text = normalizeCommentText(child.text);
    if (text) lines.push(text);
  }
  if (!sawDocShape) return undefined;
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length === 0) return undefined;
  return joined.length > DOC_MAX_LEN ? joined.slice(0, DOC_MAX_LEN - 1) + "…" : joined;
}

function isCommentNode(type: string): boolean {
  return type === "comment" || type === "line_comment" || type === "block_comment";
}

/**
 * Is this comment text in the language's idiomatic "doc" shape? Per-file
 * doc extraction only keeps comments that pass this check.
 */
function isDocShape(raw: string, lang: string): boolean {
  const s = raw.trimStart();
  if (lang === "go") return s.startsWith("//");
  // TS / JS: require a JSDoc block. Plain `/* ... */` and `//` are noise.
  return s.startsWith("/**");
}

function normalizeCommentText(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("/**")) s = s.slice(3);
  else if (s.startsWith("/*")) s = s.slice(2);
  if (s.endsWith("*/")) s = s.slice(0, -2);
  const parts = s
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\/+|#+|\*+)\s?/, "").trim())
    .filter(Boolean);
  return parts.join(" ");
}

function extractPythonModuleDocstring(root: any): string | undefined {
  if (root.type !== "module") return undefined;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (!child) continue;
    if (child.type === "comment") continue;
    if (child.type === "expression_statement") {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner.type === "string") {
          const text = stripPythonStringQuotes(inner.text);
          const firstParagraph = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
          if (!firstParagraph) return undefined;
          return firstParagraph.length > DOC_MAX_LEN
            ? firstParagraph.slice(0, DOC_MAX_LEN - 1) + "…"
            : firstParagraph;
        }
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

function stripPythonStringQuotes(text: string): string {
  for (const triple of ['"""', "'''"]) {
    if (text.startsWith(triple) && text.endsWith(triple) && text.length >= triple.length * 2) {
      return text.slice(triple.length, -triple.length);
    }
  }
  for (const single of ['"', "'"]) {
    if (text.startsWith(single) && text.endsWith(single) && text.length >= 2) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * Collapse whitespace in a raw signature snippet so multi-line parameter
 * lists don't blow up the serialized DefinesFact. Exported for adapter use.
 */
function collapseSignature(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
    // Per-file alias map: local name → imported name. Populated as
    // `import_statement` nodes are encountered during the walk, read by
    // `resolveCallee` so a call to `bar()` from `import { foo as bar }`
    // records an edge to `foo`, matching the exported name on the other
    // side of the module boundary. ES imports are syntactically required
    // to appear before any executable code, so building the map lazily
    // during the walk is safe.
    const aliasMap = new Map<string, string>();
    // Function-reference queue: every `foo` identifier passed as a direct
    // call argument is recorded here during the walk, then resolved after
    // the walk against the file's final defines + imports. Deferred
    // resolution is necessary because the reference can appear *before*
    // the callee is defined in source order (e.g. `names.map(quoteIfNeeded)`
    // above a `function quoteIfNeeded(...)` declaration).
    const pendingRefs: Array<{ caller: string; callee: string }> = [];
    walkNode(tree.rootNode, filePath, lang, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);

    // Resolve pending references. A ref becomes a real edge iff the target
    // name is a function/method defined in this file or an import binding
    // this file owns. Non-matching names are dropped so local variable
    // identifiers (req, opts, config, etc.) don't pollute the graph.
    const knownNames = new Set<string>();
    for (const d of defines) {
      if (d.file !== filePath) continue;
      if (d.kind === "function" || d.kind === "method" || d.kind === "class") {
        knownNames.add(d.name);
      }
    }
    for (const imp of imports) {
      if (imp.file === filePath) knownNames.add(imp.name);
    }
    for (const ref of pendingRefs) {
      if (!knownNames.has(ref.callee)) continue;
      if (ref.caller === ref.callee) continue;
      const key = `${ref.caller}->${ref.callee}`;
      if (callSet.has(key)) continue;
      callSet.add(key);
      calls.push({ caller: ref.caller, callee: ref.callee });
    }
  }
}

function walkNode(
  node: any,
  filePath: string,
  language: string,
  scopeStack: string[],
  aliasMap: Map<string, string>,
  pendingRefs: Array<{ caller: string; callee: string }>,
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
        defines.push({
          file: filePath, name, kind: "function",
          line: node.startPosition.row + 1,
          signature: extractJsLikeSignature(node),
        });
        scopeStack.push(name);
        walkChildren(node, filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
        scopeStack.pop();
        return; // already walked children
      }
      break;
    }

    case "method_definition": {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        defines.push({
          file: filePath, name, kind: "method",
          line: node.startPosition.row + 1,
          signature: extractJsLikeSignature(node),
        });
        // Find enclosing class for contains relationship
        const className = findEnclosingClassName(node);
        if (className) {
          contains.push({ parent: className, child: name });
        }
        scopeStack.push(name);
        walkChildren(node, filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
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
        walkChildren(node, filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
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
            defines.push({
              file: filePath, name, kind: "function",
              line: node.startPosition.row + 1,
              signature: extractJsLikeSignature(valueNode),
            });
            scopeStack.push(name);
            walkChildren(valueNode, filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
            scopeStack.pop();
            foundArrow = true;
          } else if (valueNode) {
            walkChildren(child, filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
          }
        }
      }
      if (foundArrow) return;
      break;
    }

    case "call_expression": {
      const callee = resolveCallee(node, aliasMap);
      const caller = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
      if (callee && caller) {
        const key = `${caller}->${callee}`;
        if (!callSet.has(key)) {
          callSet.add(key);
          calls.push({ caller, callee });
        }
      }
      // Record identifier arguments as potential function references.
      // Passing a fn by reference (arr.map(fn), emitter.on("sig", fn))
      // doesn't generate a call_expression for `fn` itself, so without
      // this pass the target looks unused and dead-code analysis flags
      // it as dead. We collect the (caller, argIdentifier) pairs here
      // and resolve them against the file's known function names after
      // the walk finishes.
      if (caller) {
        const argsNode = node.childForFieldName("arguments");
        if (argsNode) {
          for (let i = 0; i < argsNode.childCount; i++) {
            const arg = argsNode.child(i);
            if (arg.type !== "identifier") continue;
            const argName = arg.text;
            // Rewrite through aliasMap so a reference to an aliased
            // import resolves to the canonical exported name, matching
            // what resolveCallee does for direct calls.
            const canonical = aliasMap.get(argName) ?? argName;
            pendingRefs.push({ caller, callee: canonical });
          }
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
          extractImportNames(importClause, filePath, source, imports, aliasMap);
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
        // TypeScript type-only exports: `export interface Foo {}`,
        // `export type T = ...`, `export enum E {}`. These don't produce
        // a DefinesFact (no callable body) but the outward API of the
        // module still includes them — the map layer uses exports to
        // count/list a file's public surface, so we must capture the name.
        if (
          child.type === "interface_declaration" ||
          child.type === "type_alias_declaration" ||
          child.type === "enum_declaration"
        ) {
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

  walkChildren(node, filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
}

function walkChildren(
  node: any,
  filePath: string,
  language: string,
  scopeStack: string[],
  aliasMap: Map<string, string>,
  pendingRefs: Array<{ caller: string; callee: string }>,
  defines: DefinesFact[],
  calls: CallsFact[],
  imports: ImportsFact[],
  exports: ExportsFact[],
  contains: ContainsFact[],
  callSet: Set<string>,
): void {
  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i), filePath, language, scopeStack, aliasMap, pendingRefs, defines, calls, imports, exports, contains, callSet);
  }
}

/**
 * Resolve the callee name from a call_expression node. If the identifier
 * matches a local alias from `import { foo as bar }`, the call is
 * rewritten to the original export name (`foo`) so cross-file analyses
 * see the link. Member-expression callees aren't rewritten — they reach
 * into an object, not a top-level binding.
 */
function resolveCallee(callNode: any, aliasMap: Map<string, string>): string | null {
  const fnNode = callNode.childForFieldName("function");
  if (!fnNode) return null;

  switch (fnNode.type) {
    case "identifier": {
      const name = fnNode.text;
      return aliasMap.get(name) ?? name;
    }

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

/**
 * Extract import names from an import_clause. For each named specifier
 * we push an ImportsFact keyed by the *imported* name (so the imports
 * list reflects the exported identifier as seen by the module being
 * imported), and — when the local binding differs (an `as` alias) —
 * register a `local → imported` entry in `aliasMap` so call-site
 * resolution can rewrite calls through the alias back to the canonical
 * name used by the call graph.
 */
function extractImportNames(
  clause: any,
  filePath: string,
  source: string,
  imports: ImportsFact[],
  aliasMap: Map<string, string>,
): void {
  for (let i = 0; i < clause.childCount; i++) {
    const child = clause.child(i);

    // Default import: import foo from './bar'
    if (child.type === "identifier") {
      imports.push({ file: filePath, name: child.text, source });
    }

    // Named imports: import { foo, bar, baz as qux } from './mod'
    if (child.type === "named_imports") {
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j);
        if (spec.type !== "import_specifier") continue;
        const name = spec.childForFieldName("name")?.text;
        if (!name) continue;
        imports.push({ file: filePath, name, source });
        // `alias` field only exists when the specifier has an `as` clause.
        const alias = spec.childForFieldName("alias")?.text;
        if (alias && alias !== name) {
          aliasMap.set(alias, name);
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
        defines.push({
          file: filePath, name, kind,
          line: node.startPosition.row + 1,
          signature: extractPythonSignature(node),
        });
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
          defines.push({
            file: filePath, name, kind: "function",
            line: node.startPosition.row + 1,
            signature: extractGoSignature(node),
          });
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
          defines.push({
            file: filePath, name, kind: "method",
            line: node.startPosition.row + 1,
            signature: extractGoSignature(node),
          });
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

/**
 * Get the textual name of a Clojure symbol, preserving any namespace
 * prefix. tree-sitter-clojure parses a qualified symbol like `db/query`
 * into a sym_lit containing a `sym_ns` child ("db") and a `sym_name`
 * child ("query"); returning just the `sym_name` loses the ns info and
 * conflates cross-namespace calls. Reconstruct `ns/name` when both are
 * present, otherwise fall back to the bare `sym_name`.
 */
function cljSymName(node: any): string | null {
  if (node.type === "sym_name") return node.text;
  if (node.type === "sym_lit") {
    let ns: string | null = null;
    let name: string | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === "sym_ns") ns = c.text;
      else if (c.type === "sym_name" && name === null) name = c.text;
    }
    if (name === null) return null;
    return ns ? `${ns}/${name}` : name;
  }
  return null;
}

/**
 * Per-file Clojure context: current namespace + :as alias resolution map +
 * qualified in-file define set. Shared by every extraction helper so they
 * can emit namespace-qualified names instead of bare ones.
 */
interface CljCtx {
  /** Value of the (ns ...) form, or null if the file has no ns declaration. */
  currentNs: string | null;
  /** alias → full namespace, built from (:require [foo.bar :as x]). */
  aliasMap: Map<string, string>;
  /** Qualified names (`ns/name`) of defines in this file. Populated in phase 1. */
  inFileDefns: Set<string>;
}

/**
 * Resolve a Clojure call target to its canonical form. Rules:
 *   - `alias/name` where alias is in aliasMap → `<full-ns>/name`
 *   - `prefix/name` where prefix is unknown → returned as-is (already fully
 *     qualified, or an alias we couldn't resolve — either way, leave it)
 *   - bare `name` where `<currentNs>/name` is defined in this file → qualify
 *     to the current ns (same-file reference)
 *   - bare `name` otherwise → returned as-is (external, clojure.core, etc.)
 *
 * When `currentNs` is null (file has no ns form) the bare path just returns
 * the input, preserving the legacy "bare names everywhere" behavior for
 * script-style files.
 */
function qualifyCljName(name: string, ctx: CljCtx): string {
  const slashIdx = name.indexOf("/");
  if (slashIdx >= 0) {
    const prefix = name.slice(0, slashIdx);
    const local = name.slice(slashIdx + 1);
    const fullNs = ctx.aliasMap.get(prefix);
    if (fullNs) return `${fullNs}/${local}`;
    return name;
  }
  if (ctx.currentNs === null) return name;
  const candidate = `${ctx.currentNs}/${name}`;
  if (ctx.inFileDefns.has(candidate)) return candidate;
  return name;
}

/**
 * Extract ns form: (ns foo.bar (:require [baz.qux :as q] [x.y :refer [z]])).
 * Populates `imports` with the required namespaces and `aliasMap` with any
 * `:as` bindings so the call extractor can resolve `q/some-fn` to
 * `baz.qux/some-fn`.
 */
function cljExtractNs(
  listNode: any,
  filePath: string,
  imports: ImportsFact[],
  aliasMap: Map<string, string>,
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
              // First sym_lit in vector is the required namespace; scan for
              // a trailing `:as alias` pair so alias → full-ns can be
              // resolved at call sites.
              let reqNs: string | null = null;
              for (let l = 0; l < vec.childCount; l++) {
                const vc = vec.child(l);
                if (vc.type === "sym_lit") {
                  reqNs = cljSymName(vc);
                  break;
                }
              }
              if (!reqNs) continue;
              imports.push({ file: filePath, name: reqNs, source: reqNs });

              for (let l = 0; l < vec.childCount; l++) {
                const vc = vec.child(l);
                if (vc.type !== "kwd_lit") continue;
                const kname = vc.children?.find((c: any) => c.type === "kwd_name")?.text;
                if (kname !== "as") continue;
                for (let m = l + 1; m < vec.childCount; m++) {
                  const asSym = vec.child(m);
                  if (asSym.type === "sym_lit") {
                    const alias = cljSymName(asSym);
                    if (alias) aliasMap.set(alias, reqNs);
                    break;
                  }
                }
                break;
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
  ctx: CljCtx,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  for (let i = 0; i < parentList.childCount; i++) {
    const child = parentList.child(i);
    if (child.type !== "list_lit") continue;
    const methodName = cljMethodImplName(child);
    if (methodName) {
      // Method implementations are attributed to the bare method name
      // (not qualified): dispatch method names are looked up by unqualified
      // identifier and usually match a defprotocol entry elsewhere.
      cljExtractCalls(child, methodName, ctx, calls, callSet);
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
  const aliasMap = new Map<string, string>();
  const definesBeforePhase1 = defines.length;

  // Phase 1 pushes bare names and records the boundaries; after phase 1
  // finishes we'll rewrite them in-place to qualified form once we know the
  // final ns. Deferring the rewrite avoids having to know the ns before
  // seeing the (ns ...) form, which can appear anywhere in the file.

  // ── Phase 1: collect top-level definitions ────────────────────────
  // In addition to defn/defn-, we also register defmulti, defprotocol
  // (and its declared methods), defrecord, deftype, definterface,
  // deftest. This ensures the dead-code analysis sees them as known
  // functions/classes, and the downstream Prolog facts are complete.
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "list_lit") continue;

    // ns form — harvest requires, :as aliases, and the namespace name for
    // use as the top-level caller in phase 2.
    const ns = cljExtractNs(child, filePath, imports, aliasMap);
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
        defines.push({
          file: filePath, name, kind: "function", line,
          signature: extractCljDefnArglist(child, head.symIdx),
        });
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
              signature: extractCljProtocolMethodSignature(sub),
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

  // Post-phase-1 qualification: now that the (ns ...) form has been seen
  // (or confirmed absent), rewrite each define pushed during phase 1 to
  // its namespace-qualified form. `defprotocol`/`definterface` method rows
  // (kind === "function" nested inside a class define) are qualified too —
  // they look identical to defn from the graph's perspective. Classes
  // (defrecord/deftype/definterface) are also qualified.
  //
  // If nsName is null the file is in legacy "bare" mode and names stay as
  // they were pushed — this keeps script-style .clj fixtures working.
  if (nsName !== null) {
    for (let k = definesBeforePhase1; k < defines.length; k++) {
      defines[k].name = `${nsName}/${defines[k].name}`;
    }
    // Exports were pushed alongside defines in phase 1. They were appended
    // after definesBeforePhase1 as we went, but exports and defines are
    // separate arrays — rewrite exports for this file by walking from the
    // pre-phase-1 length of the exports array.
    // We don't have a snapshot of the export length, so scan the tail for
    // entries belonging to this file and qualify those whose name still
    // looks bare.
    for (let k = exports.length - 1; k >= 0 && exports[k].file === filePath; k--) {
      if (!exports[k].name.includes("/")) {
        exports[k].name = `${nsName}/${exports[k].name}`;
      }
    }
  }

  // Snapshot the set of names defined in *this file* during phase 1.
  // Phase 2's cljExtractCalls uses this to recognize in-file references:
  // whenever it encounters a sym_lit whose name matches one of these,
  // it emits a reference edge. Names here are already qualified if the
  // file had an ns form.
  const inFileDefns = new Set<string>();
  for (let k = definesBeforePhase1; k < defines.length; k++) {
    inFileDefns.add(defines[k].name);
  }

  const ctx: CljCtx = { currentNs: nsName, aliasMap, inFileDefns };

  // Synthetic caller for top-level side-effecting forms. If the file has
  // no ns declaration, fall back to the file path — it's still a unique
  // identifier that downstream analyses can treat as "always live".
  const topLevelCaller = nsName ?? `<toplevel:${filePath}>`;

  // ── Phase 2: walk bodies for call edges ──────────────────────────
  //
  // Phase-2 callers are qualified whenever the file has an ns form: `defn
  // foo` in `ns myapp.core` becomes the caller `myapp.core/foo`. This
  // matches the (already rewritten) entries in `defines` so cross-file
  // analyses see a consistent graph.
  const qualifyCaller = (bare: string): string =>
    nsName !== null ? `${nsName}/${bare}` : bare;

  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "list_lit") continue;

    const head = cljListHead(child);
    if (!head) {
      // Non-symbolic head (keyword-first, map-first, etc.) at top level.
      // Still walk it as file-level init — unusual but possible.
      cljExtractCalls(child, topLevelCaller, ctx, calls, callSet);
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
        if (name) cljExtractCalls(child, qualifyCaller(name), ctx, calls, callSet);
        break;
      }

      case "defmulti": {
        // No body — just the dispatch fn. Walk it so e.g.
        //   (defmulti route :path)
        // registers a reference to `:path`-like dispatch fns if they're
        // named. Attribute to the multi name.
        const name = cljNextSymNameAfter(child, head.symIdx);
        if (name) cljExtractCalls(child, qualifyCaller(name), ctx, calls, callSet);
        break;
      }

      case "defmethod": {
        // (defmethod multi-name dispatch-val [args] body). Attribute calls
        // in the body to the multi name, so a private helper invoked here
        // is recorded as "called by" the multi and won't look dead.
        const multiName = cljNextSymNameAfter(child, head.symIdx);
        if (multiName) cljExtractCalls(child, qualifyCaller(multiName), ctx, calls, callSet);
        break;
      }

      case "defrecord":
      case "deftype":
      case "extend-type":
      case "extend-protocol": {
        cljWalkDispatchMethods(child, ctx, calls, callSet);
        break;
      }

      default: {
        // Unrecognized top-level form — walk as file-level init with the
        // ns name as caller. Catches use-fixtures, (def x (compute)),
        // (require '[...]), raw println calls, etc.
        if (!CLJ_RECOGNIZED_TOPLEVEL.has(head.name)) {
          cljExtractCalls(child, topLevelCaller, ctx, calls, callSet);
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
  ctx: CljCtx,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  const emit = (calleeRaw: string): void => {
    if (!calleeRaw) return;
    // Special-form filtering happens on the bare tail: `let` is a special
    // form whether written as `let` or `some.ns/let` (the latter is
    // degenerate but the filter shouldn't care). The aliased test lets
    // us shed def/let/if/etc. before paying for resolution.
    const slashIdx = calleeRaw.indexOf("/");
    const bareTail = slashIdx >= 0 ? calleeRaw.slice(slashIdx + 1) : calleeRaw;
    if (slashIdx < 0 && CLJ_SPECIAL_FORMS.has(bareTail)) return;

    const callee = qualifyCljName(calleeRaw, ctx);
    if (!callee || callee === enclosingFn) return;
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
 * `ctx.inFileDefns`: if its qualified form matches a definition in the
 * current file, an edge is emitted. This covers in-file references that
 * aren't at list-head position — e.g. fns passed to user-defined HOFs,
 * fn values in map literals, `(def h my-fn)`, and registration-style
 * calls like `(reg-event-fx :k handler)`.
 */
function cljExtractCalls(
  node: any,
  enclosingFn: string,
  ctx: CljCtx,
  calls: CallsFact[],
  callSet: Set<string>,
): void {
  if (node.type === "list_lit" || node.type === "anon_fn_lit") {
    cljProcessCallSite(node, enclosingFn, ctx, calls, callSet);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "sym_lit") {
      const name = cljSymName(child);
      if (name) {
        const qualified = qualifyCljName(name, ctx);
        if (qualified && qualified !== enclosingFn && ctx.inFileDefns.has(qualified)) {
          const key = `${enclosingFn}->${qualified}`;
          if (!callSet.has(key)) {
            callSet.add(key);
            calls.push({ caller: enclosingFn, callee: qualified });
          }
        }
      }
    }
    if (CLJ_RECURSE_TYPES.has(child.type)) {
      cljExtractCalls(child, enclosingFn, ctx, calls, callSet);
    }
  }
}

// ── Signature extraction ─────────────────────────────────────────────

/**
 * Extract a flattened parameter list + return type (when present) for a
 * JS/TS function_declaration, method_definition, or arrow_function node.
 * Returns undefined when the node has no `parameters` field — the callers
 * only invoke this on shapes that must have one, so undefined is a bug
 * signal, not a normal result.
 */
function extractJsLikeSignature(node: any): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  let sig = params.text;
  const ret = node.childForFieldName("return_type");
  if (ret) sig += " " + ret.text;
  return collapseSignature(sig);
}

/**
 * Extract signature from a Python function_definition: parameters plus
 * return type annotation when present (`-> T` in source).
 */
function extractPythonSignature(node: any): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  let sig = params.text;
  const ret = node.childForFieldName("return_type");
  if (ret) sig += " -> " + ret.text;
  return collapseSignature(sig);
}

/**
 * Extract signature from a Go function_declaration or method_declaration:
 * parameters plus result type (tree-sitter-go's `result` field). Excludes
 * the receiver — that relationship is already captured in `contains`.
 */
function extractGoSignature(node: any): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  let sig = params.text;
  const result = node.childForFieldName("result");
  if (result) sig += " " + result.text;
  return collapseSignature(sig);
}

/**
 * Extract the arglist vector from a Clojure protocol/interface method
 * signature `(method-name [args] ?docstring)`. The method form is already
 * validated by cljMethodImplName before this is called, so the first
 * `vec_lit` child is guaranteed to be the arglist.
 */
function extractCljProtocolMethodSignature(listNode: any): string | undefined {
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child && child.type === "vec_lit") {
      return collapseSignature(child.text);
    }
  }
  return undefined;
}

/**
 * Extract the first arglist vector from a Clojure defn/defn- list_lit.
 * Handles both single-arity `(defn f [x] ...)` and single-arity with
 * leading docstring `(defn f "doc" [x] ...)`. Multi-arity defns with a
 * list of ([args] body) pairs are caught by returning the first `vec_lit`
 * found inside a nested list_lit.
 */
function extractCljDefnArglist(listNode: any, nameSymIdx: number): string | undefined {
  // Scan forward from just past the name; the arglist is either a direct
  // vec_lit child (single-arity) or a vec_lit inside a nested list_lit
  // (multi-arity). Docstrings, attr maps, and metadata are skipped over.
  for (let i = nameSymIdx + 1; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!child) continue;
    if (child.type === "vec_lit") {
      return collapseSignature(child.text);
    }
    if (child.type === "list_lit") {
      // Multi-arity: walk until we find the nested vec_lit
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && inner.type === "vec_lit") {
          return collapseSignature(inner.text);
        }
      }
    }
  }
  return undefined;
}

// ── TS/JS type info collection for qualified call resolution ────────────────

const FN_NODE_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "generator_function_declaration",
  "arrow_function",
  "function_expression",
]);

const CLASS_NODE_TYPES_SET = new Set([
  "class_declaration",
  "class",
  "abstract_class_declaration",
  "interface_declaration",
]);

function findEnclosingClassNameForTypeInfo(nodeIn: any): string | null {
  let cur: any = nodeIn.parent;
  while (cur) {
    if (CLASS_NODE_TYPES_SET.has(cur.type)) {
      const n = cur.childForFieldName?.("name");
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

function findEnclosingFnName(nodeIn: any): string | null {
  let cur: any = nodeIn.parent;
  while (cur) {
    if (cur.type === "method_definition") {
      const n = cur.childForFieldName?.("name");
      if (n) return n.text;
    }
    if (
      cur.type === "function_declaration" ||
      cur.type === "generator_function_declaration"
    ) {
      const n = cur.childForFieldName?.("name");
      if (n) return n.text;
    }
    if (cur.type === "arrow_function" || cur.type === "function_expression") {
      // Named via `const name = () => {}` — walk to variable_declarator.
      if (cur.parent?.type === "variable_declarator") {
        const n = cur.parent.childForFieldName?.("name");
        if (n?.type === "identifier") return n.text;
      }
    }
    cur = cur.parent;
  }
  return null;
}

function scopeKeyOf(nodeIn: any): string {
  let cur: any = nodeIn.parent;
  while (cur) {
    if (FN_NODE_TYPES.has(cur.type)) {
      const n = cur.childForFieldName?.("name");
      if (n) return n.text;
      if (cur.parent?.type === "variable_declarator") {
        const vn = cur.parent.childForFieldName?.("name");
        if (vn?.type === "identifier") return vn.text;
      }
      return `__anon_${cur.startPosition.row}_${cur.startPosition.column}`;
    }
    cur = cur.parent;
  }
  return "";
}

function extractAnnotationTypeLocal(declNode: any): string | undefined {
  const typeAnnNode = declNode.childForFieldName?.("type");
  if (typeAnnNode) {
    const innerType =
      typeAnnNode.childForFieldName?.("type") ?? typeAnnNode.namedChild?.(0);
    if (innerType) return simpleTypeNameOf(innerType);
  }
  for (let i = 0; i < declNode.childCount; i++) {
    const c = declNode.child(i);
    if (c && c.type === "type_annotation") {
      const inner = c.namedChild?.(0);
      if (inner) return simpleTypeNameOf(inner);
    }
  }
  return undefined;
}

function extractNewTypeLocal(valueNode: any): string | undefined {
  if (valueNode.type !== "new_expression") return undefined;
  const ctor = valueNode.childForFieldName?.("constructor");
  if (ctor) return simpleTypeNameOf(ctor);
  const fc = valueNode.namedChild?.(0);
  if (fc) return simpleTypeNameOf(fc);
  return undefined;
}

// Thin wrapper: delegates to the shared, tested implementation in type-env.ts.
// Keeps the call sites short without forcing callers to construct a node.
const simpleTypeNameOf = extractSimpleTypeName;

/**
 * Build a dotted receiver chain from a member_expression callee.
 * Returns `{ chain: [...], method }` where `chain` is the chain of
 * identifiers preceding the final property access. Returns null when
 * the chain contains anything non-trivial (computed access, call
 * expressions, etc.) — qualified resolution needs a pure chain.
 */
function extractReceiverChain(memberExpr: any): { chain: string[]; method: string } | null {
  const property = memberExpr.childForFieldName?.("property");
  if (!property || property.type !== "property_identifier") return null;
  const method = property.text;
  if (!method) return null;

  const chain: string[] = [];
  let cur: any = memberExpr.childForFieldName?.("object");
  while (cur) {
    if (cur.type === "identifier") {
      chain.unshift(cur.text);
      break;
    }
    if (cur.type === "this") {
      chain.unshift("this");
      break;
    }
    if (cur.type === "member_expression") {
      const p = cur.childForFieldName?.("property");
      if (!p || p.type !== "property_identifier") return null;
      chain.unshift(p.text);
      cur = cur.childForFieldName?.("object");
      continue;
    }
    // Anything else (call_expression, parenthesized, etc.) breaks the chain.
    return null;
  }
  if (chain.length === 0) return null;
  return { chain, method };
}

function firstIdentifierIn(node: any): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === "identifier" || c.type === "type_identifier") return c.text;
  }
  return null;
}

function extractParentClassName(classNode: any): string | null {
  // Two shapes to cover:
  //   class:     class_declaration > class_heritage > extends_clause > identifier
  //   interface: interface_declaration > extends_type_clause > type_identifier
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (!child) continue;
    // Interface: extends_type_clause directly on the declaration.
    if (child.type === "extends_type_clause") {
      const name = firstIdentifierIn(child);
      if (name) return name;
    }
    // Class: extends_clause wrapped in class_heritage.
    if (child.type === "class_heritage") {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (!inner) continue;
        if (
          inner.type === "extends_clause" ||
          inner.type === "extends_type_clause"
        ) {
          const name = firstIdentifierIn(inner);
          if (name) return name;
        }
      }
    }
  }
  return null;
}

/**
 * Collect method names defined directly on a class or interface body.
 * Covers class `method_definition` and interface `method_signature`.
 * Does NOT include inherited methods — the registry propagates extends.
 */
function extractClassMethods(classNode: any): string[] {
  const body = classNode.childForFieldName?.("body");
  if (!body) return [];
  const out: string[] = [];
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    if (
      child.type === "method_definition" ||
      child.type === "method_signature" ||
      child.type === "abstract_method_signature"
    ) {
      const nameNode = child.childForFieldName?.("name");
      if (nameNode && nameNode.text) out.push(nameNode.text);
    }
  }
  return out;
}

function collectTypeInfo(root: any, filePath: string): FileTypeInfo {
  const classFieldsByName: Record<string, Record<string, string>> = {};
  const classMethodsByName: Record<string, string[]> = {};
  const classExtends: Array<{ className: string; parent: string }> = [];
  const scopeVarTypes: Record<string, Record<string, string>> = {};

  // Pass A: collect var types per scope (file scope is "").
  function walkDecls(n: any): void {
    if (
      n.type === "lexical_declaration" ||
      n.type === "variable_declaration"
    ) {
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);
        if (!child || child.type !== "variable_declarator") continue;
        const nameNode = child.childForFieldName?.("name");
        if (!nameNode || nameNode.type !== "identifier") continue;
        const varName = nameNode.text;
        if (!varName) continue;

        const scope = scopeKeyOf(child);
        let varType = extractAnnotationTypeLocal(child);
        if (!varType) {
          const v = child.childForFieldName?.("value");
          if (v?.type === "new_expression") {
            varType = extractNewTypeLocal(v);
          } else if (v?.type === "identifier") {
            const src = v.text;
            const t =
              scopeVarTypes[scope]?.[src] ?? scopeVarTypes[""]?.[src];
            if (t) varType = t;
          }
        }
        if (varType) {
          if (!scopeVarTypes[scope]) scopeVarTypes[scope] = {};
          scopeVarTypes[scope][varName] = varType;
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walkDecls(c);
    }
  }
  walkDecls(root);

  // Pass B: collect class fields + pending calls.
  const pendingCalls: PendingCall[] = [];
  function walkCallsAndClasses(n: any): void {
    const t: string = n.type;
    if (CLASS_NODE_TYPES_SET.has(t)) {
      const nameNode = n.childForFieldName?.("name");
      if (nameNode) {
        const className: string = nameNode.text;
        const fields = extractClassFields(n);
        if (!classFieldsByName[className]) classFieldsByName[className] = {};
        for (const [k, v] of fields) classFieldsByName[className][k] = v;
        const methods = extractClassMethods(n);
        if (methods.length > 0) {
          const existing = classMethodsByName[className] ?? [];
          for (const m of methods) if (!existing.includes(m)) existing.push(m);
          classMethodsByName[className] = existing;
        }
        const parent = extractParentClassName(n);
        if (parent) classExtends.push({ className, parent });
      }
    }
    if (t === "call_expression") {
      const fnNode = n.childForFieldName?.("function");
      if (fnNode?.type === "member_expression") {
        const parsed = extractReceiverChain(fnNode);
        if (parsed) {
          const { chain, method } = parsed;
          const caller = findEnclosingFnName(n);
          if (caller) {
            const enclosingClass = findEnclosingClassNameForTypeInfo(n);
            const scope = scopeKeyOf(n);
            const fileScope = scopeVarTypes[""] ?? {};
            const fnScope = scopeVarTypes[scope] ?? {};
            const varTypes = { ...fileScope, ...fnScope };
            pendingCalls.push({
              caller,
              callee: method,
              receiverChain: chain,
              enclosingClass,
              varTypes,
            });
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walkCallsAndClasses(c);
    }
  }
  walkCallsAndClasses(root);

  const methodsOut = Object.entries(classMethodsByName).map(([className, methods]) => ({
    className,
    methods,
  }));
  return {
    file: filePath,
    classFields: Object.entries(classFieldsByName).map(([className, fields]) => ({
      className,
      fields,
    })),
    classMethods: methodsOut.length > 0 ? methodsOut : undefined,
    classExtends: classExtends.length > 0 ? classExtends : undefined,
    pendingCalls,
  };
}
