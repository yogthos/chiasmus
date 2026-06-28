import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChiasmusConfig } from "../config.js";
import type { EmbeddingAdapter } from "./types.js";

/**
 * Minimal contract between {@link LocalEmbeddingAdapter} and the model backend.
 * Production wiring lives in {@link defaultLoadModel}; tests inject a fake.
 */
export interface EmbeddingSession {
  embed(texts: string[]): Promise<number[][]>;
  dispose(): Promise<void> | void;
}

export type LoadModelFn = (config: {
  model: string;
  modelsDir?: string;
}) => Promise<EmbeddingSession>;

export interface LocalEmbeddingAdapterOptions {
  model: string;
  modelsDir?: string;
  /** Fixed dimension; otherwise discovered from the first embedding. */
  dimension?: number;
  /** Texts per backend call (default 32). */
  batchSize?: number;
  /** Override the loader — used by tests. Defaults to {@link defaultLoadModel}. */
  loadModel?: LoadModelFn;
}

/**
 * Runs embeddings locally via node-llama-cpp. The model is loaded lazily on the
 * first {@link embed} call and reused for the lifetime of the adapter. A failed
 * load is not cached — the next call retries.
 */
export class LocalEmbeddingAdapter implements EmbeddingAdapter {
  private readonly model: string;
  private readonly modelsDir?: string;
  private readonly batchSize: number;
  private readonly loadModel: LoadModelFn;
  private dim: number | null;
  private sessionPromise: Promise<EmbeddingSession> | null = null;

  constructor(opts: LocalEmbeddingAdapterOptions) {
    this.model = opts.model;
    this.modelsDir = opts.modelsDir;
    this.batchSize = opts.batchSize ?? 32;
    this.loadModel = opts.loadModel ?? defaultLoadModel;
    this.dim = opts.dimension ?? null;
  }

  dimension(): number {
    if (this.dim === null) {
      throw new Error(
        "Local embedding dimension is unknown until the first embed() call. " +
          "Set `dimension` (or CHIASMUS_LOCAL_EMBED_DIM) to query it eagerly.",
      );
    }
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const session = await this.getSession();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const vecs = await session.embed(chunk);
      for (const v of vecs) {
        if (this.dim === null) this.dim = v.length;
        out.push(v);
      }
    }
    return out;
  }

  /** Release the underlying model session (no-op if never loaded). */
  async dispose(): Promise<void> {
    const p = this.sessionPromise;
    this.sessionPromise = null;
    if (p) {
      try {
        await p.then((s) => s.dispose());
      } catch {
        // best-effort
      }
    }
  }

  private getSession(): Promise<EmbeddingSession> {
    if (this.sessionPromise) return this.sessionPromise;
    // Single-flight: a failed load clears the slot so the next call retries.
    this.sessionPromise = this.loadModel({ model: this.model, modelsDir: this.modelsDir }).catch(
      (err) => {
        this.sessionPromise = null;
        throw err;
      },
    );
    return this.sessionPromise;
  }
}

export interface ResolvedLocalEmbeddingConfig {
  enabled: boolean;
  model?: string;
  modelsDir?: string;
  dimension?: number;
  batchSize: number;
}

const DEFAULT_BATCH_SIZE = 32;

function isTruthyFlag(v: string | undefined): boolean {
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/**
 * Merge the config-file `localEmbeddings` block with `CHIASMUS_LOCAL_EMBED_*`
 * environment variables. Env wins per-field; `enabled` is true if either source
 * turns it on.
 */
export function resolveLocalEmbeddingConfig(
  config: ChiasmusConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  chiasmusHome?: string,
): ResolvedLocalEmbeddingConfig {
  const block = config?.localEmbeddings;
  const enabled =
    (block?.enabled ?? false) || isTruthyFlag(env.CHIASMUS_LOCAL_EMBED as string | undefined);

  const model = (env.CHIASMUS_LOCAL_EMBED_MODEL as string | undefined) ?? block?.model;
  const modelsDir =
    (env.CHIASMUS_LOCAL_EMBED_DIR as string | undefined) ?? block?.modelsDir ?? defaultModelsDir(chiasmusHome);
  const dimEnv = env.CHIASMUS_LOCAL_EMBED_DIM;
  const dimension =
    dimEnv !== undefined && Number.isFinite(Number(dimEnv)) ? Number(dimEnv) : block?.dimension;
  const batchEnv = env.CHIASMUS_LOCAL_EMBED_BATCH;
  const batchSize =
    batchEnv !== undefined && Number.isFinite(Number(batchEnv)) && Number(batchEnv) > 0
      ? Number(batchEnv)
      : DEFAULT_BATCH_SIZE;

  const resolved: ResolvedLocalEmbeddingConfig = {
    enabled,
    batchSize,
    modelsDir,
  };
  if (model) resolved.model = model;
  if (dimension !== undefined) resolved.dimension = dimension;
  return resolved;
}

function defaultModelsDir(chiasmusHome?: string): string | undefined {
  return chiasmusHome ? join(chiasmusHome, "models") : undefined;
}

/** Narrow view of the node-llama-cpp API surface this adapter uses. */
interface NodeLlamaCppEmbedding {
  vector: ArrayLike<number>;
}
interface NodeLlamaCppEmbeddingContext {
  getEmbeddingFor(text: string): Promise<NodeLlamaCppEmbedding>;
}
interface NodeLlamaCppModel {
  createEmbeddingContext(): Promise<NodeLlamaCppEmbeddingContext>;
  dispose(): Promise<void>;
}
interface NodeLlamaCppLlama {
  loadModel(opts: { modelPath: string }): Promise<NodeLlamaCppModel>;
}
interface NodeLlamaCpp {
  resolveModelFile(uriOrPath: string, dirname?: string): Promise<string>;
  getLlama(): Promise<NodeLlamaCppLlama>;
}

/**
 * Production loader: dynamically imports node-llama-cpp (kept out of the hard
 * dependency graph so the base install stays lean and the feature is opt-in),
 * resolves/downloads the GGUF model from HuggingFace, and returns an embedding
 * session. Throws with an install hint if the package is missing.
 */
export async function defaultLoadModel(cfg: {
  model: string;
  modelsDir?: string;
}): Promise<EmbeddingSession> {
  let nlc: NodeLlamaCpp;
  try {
    // Non-literal specifier so TypeScript does not resolve (and require) the
    // optional package at type-check time; resolution happens at runtime.
    const moduleName = "node-llama-cpp";
    nlc = (await import(moduleName)) as NodeLlamaCpp;
  } catch {
    throw new Error(
      "Local embeddings are enabled but `node-llama-cpp` could not be loaded. " +
        "Install it alongside chiasmus: `npm install node-llama-cpp` " +
        "(or `pnpm add node-llama-cpp` / `yarn add node-llama-cpp`).",
    );
  }

  const uri = resolveModelUri(cfg.model);
  const modelPath = await nlc.resolveModelFile(uri, cfg.modelsDir);
  const llama = await nlc.getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  return {
    async embed(texts: string[]) {
      const out: number[][] = [];
      for (const text of texts) {
        const emb = await context.getEmbeddingFor(text);
        out.push(Array.from(emb.vector));
      }
      return out;
    },
    async dispose() {
      await model.dispose();
    },
  };
}

/**
 * Normalize a user-provided model identifier into a node-llama-cpp model URI:
 *   - `hf:`, `http(s):`, or an existing local path → used as-is
 *   - a bare repo id (`org/repo`) → prefixed with `hf:`
 */
function resolveModelUri(model: string): string {
  if (/^(hf:|https?:|file:)/i.test(model)) return model;
  if (existsSync(model)) return model;
  return model.startsWith("hf:") ? model : `hf:${model}`;
}
