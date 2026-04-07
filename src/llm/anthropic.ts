import type { LLMAdapter, LLMMessage } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

export class AnthropicAdapter implements LLMAdapter {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config: AnthropicConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.baseUrl ?? DEFAULT_URL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(system: string, messages: LLMMessage[]): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const textBlock = data.content.find((b) => b.type === "text");
    return textBlock?.text ?? "";
  }
}

/** Create an LLM adapter from environment variables, or null if not configured */
export function createLLMFromEnv(): LLMAdapter | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  return new AnthropicAdapter({
    apiKey,
    model: process.env.CHIASMUS_MODEL,
  });
}
