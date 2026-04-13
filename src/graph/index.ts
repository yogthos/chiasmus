export { extractGraph } from "./extractor.js";
export { runAnalysis, runAnalysisFromGraph, buildFactsResult, DEFAULT_FACTS_MAX_BYTES } from "./analyses.js";
export type { AnalysisType, AnalysisRequest, AnalysisResult, FactsOversizeError } from "./analyses.js";
export { parseMermaid } from "./mermaid.js";
export { graphToProlog, escapeAtom, BUILTIN_RULES } from "./facts.js";
export { registerAdapter, getAdapter, getAdapterForExt, getAdapterExtensions, clearAdapters, discoverAdapters } from "./adapter-registry.js";
export type { CodeGraph, DefinesFact, CallsFact, ImportsFact, ExportsFact, ContainsFact, FileNode, LanguageAdapter, SymbolKind } from "./types.js";
export {
  fileHash,
  checkFileCache,
  saveFileCache,
  clearRepoCache,
  resolveCachePaths,
  evictLRU,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  deleteSnapshot,
  CACHE_SCHEMA_VERSION,
} from "./cache.js";
export type { CacheOptions, CachePaths } from "./cache.js";
export { detectCommunities, cohesionScore } from "./community.js";
export type { Community } from "./community.js";
export { detectHubs, detectBridges, detectSurprisingConnections } from "./insights.js";
export type { Hub, Bridge, SurprisingConnection } from "./insights.js";
export { graphDiff } from "./diff.js";
export type { GraphDiffResult, GraphDiffEdge } from "./diff.js";
