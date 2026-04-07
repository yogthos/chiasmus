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
