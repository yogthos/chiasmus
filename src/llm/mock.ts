import { createHash } from "node:crypto";
import type { EmbeddingAdapter, LLMAdapter, LLMMessage } from "./types.js";

/**
 * Mock LLM adapter for testing. Returns pre-configured responses
 * based on pattern matching against the user message.
 */
export class MockLLMAdapter implements LLMAdapter {
  responses: Array<{ pattern: RegExp; response: string | (() => string) }> = [];
  private defaultResponse: string;
  public calls: Array<{ system: string; messages: LLMMessage[] }> = [];

  constructor(defaultResponse = "") {
    this.defaultResponse = defaultResponse;
  }

  /** Register a response for messages matching a pattern */
  onMatch(pattern: RegExp, response: string | (() => string)): this {
    this.responses.push({ pattern, response });
    return this;
  }

  async complete(system: string, messages: LLMMessage[]): Promise<string> {
    this.calls.push({ system, messages });

    const lastUserMsg = messages.findLast((m: LLMMessage) => m.role === "user")?.content ?? "";
    const fullText = system + " " + lastUserMsg;

    for (const entry of this.responses) {
      if (entry.pattern.test(fullText)) {
        return typeof entry.response === "function" ? entry.response() : entry.response;
      }
    }

    return this.defaultResponse;
  }
}

export interface MockEmbeddingConfig {
  dimension: number;
}

/**
 * Deterministic mock embedder for tests. Each text is hashed (SHA-256)
 * into a pseudo-random vector seeded by the digest bytes. Same input
 * always yields the same vector; different inputs almost always differ.
 */
export class MockEmbeddingAdapter implements EmbeddingAdapter {
  private readonly dim: number;
  public calls: string[][] = [];

  constructor(config: MockEmbeddingConfig) {
    this.dim = config.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((t) => this.vectorFor(t));
  }

  dimension(): number {
    return this.dim;
  }

  private vectorFor(text: string): number[] {
    const h = createHash("sha256").update(text, "utf8").digest();
    const out = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const byte = h[i % h.length];
      // Map [0, 255] → [-1, 1). Adequate spread for distinctness tests.
      out[i] = (byte / 128) - 1;
    }
    return out;
  }
}
