import type { EmbeddingAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_API_VERSION = "2023-05-15";

export interface AzureOpenAIEmbeddingConfig {
  apiKey: string;
  /** Azure OpenAI resource endpoint, e.g. "https://my-resource.openai.azure.com" */
  endpoint: string;
  /** Deployment name (Azure routes by deployment, not model). */
  deployment: string;
  /** Azure OpenAI API version, e.g. "2023-05-15". */
  apiVersion?: string;
  /** Optional fixed dimension. Defaults to the deployment's native output. */
  dimension?: number;
  /** Max texts per request. Defaults to 16 (Azure embedding limit). */
  batchSize?: number;
}

/**
 * Adapter for Azure OpenAI embeddings. Differs from the vanilla
 * OpenAI-compatible adapter in two ways:
 *   - auth header is `api-key`, not `Authorization: Bearer`
 *   - URL is `<endpoint>/openai/deployments/<deployment>/embeddings?api-version=<v>`
 *     (the deployment determines the model; no `model` field in the body)
 *
 * Azure caps embedding requests at 16 inputs by default; the adapter
 * batches accordingly.
 */
export class AzureOpenAIEmbeddingAdapter implements EmbeddingAdapter {
  private apiKey: string;
  private url: string;
  private dim: number | null;
  private batchSize: number;

  constructor(config: AzureOpenAIEmbeddingConfig) {
    const endpoint = config.endpoint.replace(/\/+$/, "");
    const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.apiKey = config.apiKey;
    this.url = `${endpoint}/openai/deployments/${config.deployment}/embeddings?api-version=${apiVersion}`;
    this.dim = config.dimension ?? null;
    this.batchSize = config.batchSize ?? 16;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const body: Record<string, unknown> = { input: chunk };
      if (this.dim !== null) body.dimensions = this.dim;

      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Azure embeddings API error ${response.status}: ${text}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      const sorted = [...data.data].sort((a, b) => a.index - b.index);
      for (const row of sorted) {
        if (this.dim === null) this.dim = row.embedding.length;
        out.push(row.embedding);
      }
    }
    return out;
  }

  dimension(): number {
    if (this.dim === null) {
      throw new Error(
        "Embedding dimension is unknown until the first embed() call. Pass { dimension } in config to avoid this.",
      );
    }
    return this.dim;
  }
}
