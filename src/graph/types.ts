export type SymbolKind = "function" | "method" | "class" | "interface" | "variable";

export interface DefinesFact {
  file: string;
  name: string;
  kind: SymbolKind;
  line: number;
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
}

export interface CodeGraph {
  defines: DefinesFact[];
  calls: CallsFact[];
  imports: ImportsFact[];
  exports: ExportsFact[];
  contains: ContainsFact[];
  files?: FileNode[];
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
