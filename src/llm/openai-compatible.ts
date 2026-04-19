import type { EmbeddingAdapter, LLMAdapter, LLMMessage } from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
}

/**
 * Adapter for OpenAI-compatible APIs (DeepSeek, OpenRouter, Ollama, etc.)
 * Uses the standard /chat/completions format.
 */
export class OpenAICompatibleAdapter implements LLMAdapter {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;

  constructor(config: OpenAICompatibleConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(system: string, messages: LLMMessage[]): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system" as const, content: system },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ],
    };

    const url = `${this.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "";
  }
}

export interface OpenAICompatibleEmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Optional fixed dimension. Defaults to the model's native output. */
  dimension?: number;
  /** Max texts per request. Defaults to 96 (safe across providers). */
  batchSize?: number;
}

/**
 * Adapter for OpenAI-compatible embedding endpoints (OpenAI, OpenRouter,
 * DeepSeek, …). Uses `/embeddings` with the standard request shape:
 *   { model, input: string[], dimensions?: number }
 * Batches inputs automatically when the caller hands us more than
 * `batchSize` texts per call.
 */
export class OpenAICompatibleEmbeddingAdapter implements EmbeddingAdapter {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dim: number | null;
  private batchSize: number;

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.dim = config.dimension ?? null;
    this.batchSize = config.batchSize ?? 96;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const body: Record<string, unknown> = { model: this.model, input: chunk };
      if (this.dim !== null) body.dimensions = this.dim;

      const url = `${this.baseUrl}/embeddings`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Embeddings API error ${response.status}: ${text}`);
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
