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
}

export interface ImportsFact {
  file: string;
  name: string;
  source: string;
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

export interface CodeGraph {
  defines: DefinesFact[];
  calls: CallsFact[];
  imports: ImportsFact[];
  exports: ExportsFact[];
  contains: ContainsFact[];
  files?: FileNode[];
  hyperedges?: Hyperedge[];
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
