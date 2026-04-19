export { VectorStore } from "./vector-store.js";
export type {
  VectorRecord,
  VectorSearchHit,
  VectorStoreConfig,
} from "./vector-store.js";
export { EmbeddingCache } from "./embedding-cache.js";
export type {
  EmbeddingCacheConfig,
  PartitionResult,
} from "./embedding-cache.js";
export { buildSearchCorpus, runSearch } from "./engine.js";
export type {
  SearchCorpusEntry,
  SearchHit,
  RunSearchOptions,
} from "./engine.js";
