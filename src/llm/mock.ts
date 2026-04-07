import type { LLMAdapter, LLMMessage } from "./types.js";

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
