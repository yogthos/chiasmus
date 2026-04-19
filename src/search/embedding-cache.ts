// SHA-256-keyed embedding cache. Same idea as graph/cache.ts but single-
// file, content-keyed, and tolerant of missing files. Keeps embeddings
// alive across extractGraph runs so only changed content is re-embedded.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = "1";

export interface EmbeddingCacheConfig {
  /** Absolute path to the cache file (JSON). */
  cachePath: string;
  /**
   * Vector dimension. Used to validate persisted entries on load — a
   * dimension change (model swap) invalidates the cache cleanly.
   */
  dimension: number;
}

export interface PartitionResult {
  /** Index → cached vector, for hits. */
  cached: Map<number, number[]>;
  /** Miss contents in input order (same length as missingIndexes). */
  missing: string[];
  /** Indexes (into input) of misses, same order as `missing`. */
  missingIndexes: number[];
}

/**
 * Content-hash-keyed embedding cache. Map is in-memory; `save()` flushes
 * to disk atomically, `load()` reads back if the file exists.
 */
export class EmbeddingCache {
  private readonly path: string;
  private readonly dim: number;
  private readonly byHash = new Map<string, number[]>();
  private dirty = false;

  constructor(config: EmbeddingCacheConfig) {
    this.path = config.cachePath;
    this.dim = config.dimension;
  }

  private static hash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  get(content: string): number[] | null {
    return this.byHash.get(EmbeddingCache.hash(content)) ?? null;
  }

  put(content: string, vector: number[]): void {
    if (vector.length !== this.dim) {
      throw new Error(
        `EmbeddingCache: dimension mismatch — expected ${this.dim}, got ${vector.length}`,
      );
    }
    this.byHash.set(EmbeddingCache.hash(content), vector);
    this.dirty = true;
  }

  putMany(contents: string[], vectors: number[][]): void {
    if (contents.length !== vectors.length) {
      throw new Error(
        `EmbeddingCache.putMany: length mismatch — ${contents.length} contents vs ${vectors.length} vectors`,
      );
    }
    for (let i = 0; i < contents.length; i++) {
      this.put(contents[i], vectors[i]);
    }
  }

  /**
   * Split `contents` into already-cached vs needs-embedding. Preserves
   * input order and returns a cached index map so the caller can
   * reconstruct the final vector list in one pass after embedding the
   * missing entries.
   */
  partitionMissing(contents: string[]): PartitionResult {
    const cached = new Map<number, number[]>();
    const missing: string[] = [];
    const missingIndexes: number[] = [];
    for (let i = 0; i < contents.length; i++) {
      const hit = this.get(contents[i]);
      if (hit) {
        cached.set(i, hit);
      } else {
        missing.push(contents[i]);
        missingIndexes.push(i);
      }
    }
    return { cached, missing, missingIndexes };
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      dimension: this.dim,
      entries: Object.fromEntries(this.byHash),
    };
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(payload));
    await fs.rename(tmp, this.path);
    this.dirty = false;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch {
      return;
    }
    let parsed: {
      schemaVersion?: string;
      dimension?: number;
      entries?: Record<string, number[]>;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) return;
    if (parsed.dimension !== this.dim) return;
    for (const [hash, vec] of Object.entries(parsed.entries ?? {})) {
      if (vec.length === this.dim) this.byHash.set(hash, vec);
    }
    this.dirty = false;
  }

  size(): number {
    return this.byHash.size;
  }
}
