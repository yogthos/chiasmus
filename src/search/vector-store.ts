// In-process vector store with linear-scan cosine search.
// Correct up to ~10k vectors; switch to an HNSW backing if the corpus
// grows substantially. Serializable as JSON for on-disk persistence.

const SCHEMA_VERSION = "1";

export interface VectorRecord {
  id: string;
  /** Dense vector. Need not be pre-normalized; we normalize at query time. */
  vector: number[];
  /** Arbitrary metadata carried alongside the vector. */
  metadata?: Record<string, unknown>;
}

export interface VectorSearchHit {
  id: string;
  /** Cosine similarity, in [-1, 1]. Higher = more similar. */
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorStoreConfig {
  dimension: number;
}

interface InternalRow {
  id: string;
  vector: number[];
  /** Precomputed L2 norm of vector, cached to skip sqrt per query. */
  norm: number;
  metadata?: Record<string, unknown>;
}

/**
 * Linear-scan vector store with L2-normalized cosine similarity.
 * O(N·D) per query — fine for small-to-mid corpora.
 */
export class VectorStore {
  private readonly dim: number;
  private readonly byId = new Map<string, InternalRow>();

  constructor(config: VectorStoreConfig) {
    this.dim = config.dimension;
  }

  /** Add or replace a vector record. */
  add(rec: VectorRecord): void {
    if (rec.vector.length !== this.dim) {
      throw new Error(
        `VectorStore: expected dimension ${this.dim}, got ${rec.vector.length}`,
      );
    }
    const norm = l2Norm(rec.vector);
    this.byId.set(rec.id, {
      id: rec.id,
      vector: rec.vector,
      norm,
      metadata: rec.metadata,
    });
  }

  /** Remove an entry. Returns true if something was deleted. */
  remove(id: string): boolean {
    return this.byId.delete(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  size(): number {
    return this.byId.size;
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  /**
   * Top-K nearest neighbors of `query` by cosine similarity.
   * Query vector is normalized on the fly; stored vectors use their
   * cached norms. Time: O(N·D + N·logK).
   */
  search(query: number[], topK: number): VectorSearchHit[] {
    if (query.length !== this.dim) {
      throw new Error(
        `VectorStore: query dimension ${query.length} != store dimension ${this.dim}`,
      );
    }
    if (this.byId.size === 0 || topK <= 0) return [];
    const qNorm = l2Norm(query);
    if (qNorm === 0) return [];

    const scored: VectorSearchHit[] = [];
    for (const row of this.byId.values()) {
      if (row.norm === 0) continue;
      let dot = 0;
      for (let i = 0; i < this.dim; i++) dot += row.vector[i] * query[i];
      const score = dot / (row.norm * qNorm);
      scored.push({ id: row.id, score, metadata: row.metadata });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Serialize to a JSON string suitable for on-disk persistence. */
  serialize(): string {
    const vectors: Array<{
      id: string;
      vector: number[];
      metadata?: Record<string, unknown>;
    }> = [];
    for (const row of this.byId.values()) {
      vectors.push({
        id: row.id,
        vector: row.vector,
        ...(row.metadata ? { metadata: row.metadata } : {}),
      });
    }
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      dimension: this.dim,
      vectors,
    });
  }

  /** Restore from `serialize()` output. */
  static parse(raw: string): VectorStore {
    const parsed = JSON.parse(raw) as {
      schemaVersion?: string;
      dimension?: number;
      vectors?: Array<{
        id: string;
        vector: number[];
        metadata?: Record<string, unknown>;
      }>;
    };
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `VectorStore: unsupported schema version ${parsed.schemaVersion} (expected ${SCHEMA_VERSION})`,
      );
    }
    if (typeof parsed.dimension !== "number") {
      throw new Error("VectorStore: missing dimension");
    }
    const store = new VectorStore({ dimension: parsed.dimension });
    for (const v of parsed.vectors ?? []) {
      store.add({ id: v.id, vector: v.vector, metadata: v.metadata });
    }
    return store;
  }
}

function l2Norm(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}
