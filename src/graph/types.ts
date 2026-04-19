export type SymbolKind = "function" | "method" | "class" | "interface" | "variable";

export interface DefinesFact {
  file: string;
  name: string;
  kind: SymbolKind;
  line: number;
  /**
   * Raw signature text for callable/type defines, as it appears in source
   * (params list and, when cheap to capture, return type / arglist vector).
   * Populated for function/method/class defines per language adapter; left
   * undefined for variable defines or when the adapter can't resolve it.
   */
  signature?: string;
}

export interface CallsFact {
  caller: string;
  callee: string;
  /**
   * Optional fully qualified callee name when the extractor could resolve
   * the receiver type (e.g. `src/auth.ts:AuthStorage.login`). Emitted as a
   * `calls_qn/3` Prolog fact alongside the back-compatible `calls/2`.
   */
  calleeQN?: string;
}

export interface ImportsFact {
  file: string;
  name: string;
  /** Raw import specifier as written in source (e.g. "./foo.js" or "@/lib/x"). */
  source: string;
  /**
   * Optional canonical file path (repo-relative) when the import resolved
   * to a known file. Populated by the TS/JS resolver using tsconfig path
   * aliases and a suffix index over the current extraction batch. Stays
   * undefined for external package imports and bare specifiers with no
   * matching in-batch file.
   */
  resolved?: string;
}

export interface ExportsFact {
  file: string;
  name: string;
}

export interface ContainsFact {
  parent: string;
  child: string;
}

export interface FileNode {
  path: string;
  language: string;
  /**
   * Leading file-level doc: first JSDoc/docstring/comment block at the top
   * of the file, normalized to a single trimmed paragraph. Used by the map
   * projection to give an LLM a 1-line description without reading the
   * file. Undefined when the file has no leading comment or docstring.
   */
  fileDoc?: string;
  /** Approximate token count (content length / 3.5, rounded up). */
  tokenEstimate?: number;
  /** Total line count of the file at extraction time. */
  lineCount?: number;
}

/**
 * A named group of 3+ nodes related by a shared relation. Examples:
 *   - all implementations of a protocol/interface
 *   - all handlers registered for an event channel
 *   - all functions participating in an auth flow
 *
 * Hyperedges are additive over the pairwise call graph — they carry group
 * semantics that binary edges can't express. No auto-detection today;
 * external consumers (adapters, template authors) populate them.
 */
export interface Hyperedge {
  id: string;
  label: string;
  nodes: string[];
  relation: string;
  source_file?: string;
}

/**
 * Per-file type information used for cross-file qualified-name resolution.
 * Emitted by the TS/JS extractor when receiver types could be inferred,
 * merged project-wide in `extractGraph` to fill `CallsFact.calleeQN`.
 * Internal; external consumers can ignore.
 */
export interface FileTypeInfo {
  file: string;
  /** Class name → { fieldName → typeName (short) } */
  classFields: Array<{ className: string; fields: Record<string, string> }>;
  /**
   * Method names defined on each class/interface. Enables the QN
   * resolver to verify that the final receiver type actually declares
   * the method before emitting a `Class.method` name.
   */
  classMethods?: Array<{ className: string; methods: string[] }>;
  /**
   * `class Child extends Parent` relationships. Drives field + method
   * inheritance in the project-wide registry. Only direct parents are
   * tracked; the registry handles transitive extension.
   */
  classExtends?: Array<{ className: string; parent: string }>;
  /** Call sites waiting for qualified-name resolution. */
  pendingCalls: PendingCall[];
}

export interface PendingCall {
  caller: string;
  callee: string;
  /**
   * Receiver chain before the method. Empty for bare function calls
   * (`foo()`). `['this']` for `this.foo()`. `['this', 'svc']` for
   * `this.svc.foo()`. `['s']` for `s.foo()` where `s` is a local var.
   */
  receiverChain: string[];
  enclosingClass: string | null;
  /** varName → typeName (short) snapshot at call-site scope. */
  varTypes: Record<string, string>;
}

export interface CodeGraph {
  defines: DefinesFact[];
  calls: CallsFact[];
  imports: ImportsFact[];
  exports: ExportsFact[];
  contains: ContainsFact[];
  files?: FileNode[];
  hyperedges?: Hyperedge[];
  /** Internal: per-file type info for 2-pass QN resolution. */
  _typeInfo?: FileTypeInfo[];
}

/** User-provided language adapter for custom tree-sitter grammars */
export interface LanguageAdapter {
  /** Language identifier, e.g., "rust" */
  language: string;
  /** File extensions this adapter handles, e.g., [".rs"] */
  extensions: string[];
  /** Tree-sitter grammar configuration */
  grammar:
    | { package: string; moduleExport?: string; wasm?: false }
    | { package: string; wasmFile: string; wasm: true };
  /** Extract code graph facts from a parsed AST root node */
  extract(rootNode: any, filePath: string): CodeGraph;
  /** Optional: additional directories to scan for more adapter modules */
  searchPaths?: string[];
}
