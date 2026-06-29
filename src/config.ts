import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LocalEmbeddingsConfig {
  /** Master switch. When false/absent, local embeddings are never selected. */
  enabled: boolean;
  /**
   * Model identifier passed to node-llama-cpp `resolveModelFile`. Accepts:
   *   - a full URI: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF` (or with a `:quant` suffix)
   *   - a bare Hugging Face repo id: `Qwen/Qwen3-Embedding-0.6B-GGUF`
   *   - a local GGUF file path
   *   - an http(s) URL to a .gguf file
   *
   * Required to actually produce embeddings; selection warns if `enabled`
   * is set without a model.
   */
  model?: string;
  /** Optional fixed embedding dimension; otherwise discovered on first embed(). */
  dimension?: number;
  /** Optional directory to cache downloaded models (defaults to $CHIASMUS_HOME/models). */
  modelsDir?: string;
}

export interface ChiasmusConfig {
  /** Enable auto-discovery of chiasmus-adapter-* packages at startup (default: false) */
  adapterDiscovery: boolean;
  /** Opt-in: run embeddings locally via node-llama-cpp (e.g. Qwen3-Embedding). */
  localEmbeddings?: LocalEmbeddingsConfig;
}

const DEFAULTS: ChiasmusConfig = {
  adapterDiscovery: false,
};

/** Load config from ~/.chiasmus/config.json, falling back to defaults */
export function loadConfig(chiasmusHome: string): ChiasmusConfig {
  const configPath = join(chiasmusHome, "config.json");
  if (!existsSync(configPath)) return { ...DEFAULTS };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      adapterDiscovery:
        typeof raw.adapterDiscovery === "boolean" ? raw.adapterDiscovery : DEFAULTS.adapterDiscovery,
      localEmbeddings: parseLocalEmbeddings(raw.localEmbeddings),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function parseLocalEmbeddings(value: unknown): LocalEmbeddingsConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const enabled = raw.enabled === true;
  const model = typeof raw.model === "string" ? raw.model : undefined;
  const dimension =
    typeof raw.dimension === "number" && Number.isFinite(raw.dimension) ? raw.dimension : undefined;
  const modelsDir = typeof raw.modelsDir === "string" ? raw.modelsDir : undefined;
  const out: LocalEmbeddingsConfig = { enabled };
  if (model) out.model = model;
  if (dimension !== undefined) out.dimension = dimension;
  if (modelsDir) out.modelsDir = modelsDir;
  return out;
}
