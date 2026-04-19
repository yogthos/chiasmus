/** A message in the LLM conversation */
export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

/** Interface for LLM backends */
export interface LLMAdapter {
  /** Generate a completion from a system prompt and messages */
  complete(system: string, messages: LLMMessage[]): Promise<string>;
}

/**
 * Interface for embedding backends. Converts text to fixed-size dense
 * vectors suitable for cosine-similarity search. Batching is required
 * because single-vector calls have outsized per-request overhead.
 */
export interface EmbeddingAdapter {
  /** Produce dense vectors for a batch of texts (same order). */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimension of the output vectors — used to size the vector store. */
  dimension(): number;
}
