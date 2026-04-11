import type { LLMAdapter, LLMMessage } from "./types.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

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
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
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

/**
 * Create an LLM adapter from environment variables, or null if not configured.
 *
 * Supported providers (checked in order):
 *   ANTHROPIC_API_KEY  → Anthropic (Claude)
 *   DEEPSEEK_API_KEY   → DeepSeek
 *   OPENAI_API_KEY     → OpenAI
 *
 * Override base URL with CHIASMUS_API_URL and model with CHIASMUS_MODEL.
 */
export function createLLMFromEnv(): LLMAdapter | null {
  const model = process.env.CHIASMUS_MODEL;
  const customUrl = process.env.CHIASMUS_API_URL;

  // Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return new AnthropicAdapter({
      apiKey: anthropicKey,
      model,
      baseUrl: customUrl,
    });
  }

  // DeepSeek / OpenAI-compatible
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    return new OpenAICompatibleAdapter({
      apiKey: deepseekKey,
      baseUrl: customUrl ?? "https://api.deepseek.com",
      model: model ?? "deepseek-chat",
    });
  }

  // OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return new OpenAICompatibleAdapter({
      apiKey: openaiKey,
      baseUrl: customUrl ?? "https://api.openai.com/v1",
      model: model ?? "gpt-4o",
    });
  }

  return null;
}
