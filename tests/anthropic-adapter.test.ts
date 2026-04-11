import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AnthropicAdapter } from "../src/llm/anthropic.js";

describe("AnthropicAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("defaults to claude-sonnet-4-6 when no model is configured", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "test" });
    await adapter.complete("system", [{ role: "user", content: "hi" }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("honors an explicit model override", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "test", model: "claude-opus-4-6" });
    await adapter.complete("system", [{ role: "user", content: "hi" }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-opus-4-6");
  });
});
