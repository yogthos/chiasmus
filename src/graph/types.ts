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

export interface CodeGraph {
  defines: DefinesFact[];
  calls: CallsFact[];
  imports: ImportsFact[];
  exports: ExportsFact[];
  contains: ContainsFact[];
}
