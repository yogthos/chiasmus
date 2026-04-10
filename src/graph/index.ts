export { extractGraph } from "./extractor.js";
export { runAnalysis, runAnalysisFromGraph } from "./analyses.js";
export type { AnalysisType, AnalysisRequest, AnalysisResult } from "./analyses.js";
export { parseMermaid } from "./mermaid.js";
export { graphToProlog, escapeAtom, BUILTIN_RULES } from "./facts.js";
export { registerAdapter, getAdapter, getAdapterForExt, getAdapterExtensions, clearAdapters, discoverAdapters } from "./adapter-registry.js";
export type { CodeGraph, DefinesFact, CallsFact, ImportsFact, ExportsFact, ContainsFact, LanguageAdapter, SymbolKind } from "./types.js";
