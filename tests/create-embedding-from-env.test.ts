import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEmbeddingFromEnv } from "../src/llm/anthropic.js";
import { AzureOpenAIEmbeddingAdapter } from "../src/llm/azure-openai.js";
import { OpenAICompatibleEmbeddingAdapter } from "../src/llm/openai-compatible.js";

// Env vars the factory consults. Cleared in beforeEach so each test
// starts from a known-empty state — node may have any of these set in
// the developer's shell or CI.
const RELEVANT_VARS = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_ENDPOINT",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_EMBED_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "CHIASMUS_EMBED_MODEL",
  "CHIASMUS_EMBED_URL",
  "CHIASMUS_EMBED_DIM",
] as const;

describe("createEmbeddingFromEnv", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const v of RELEVANT_VARS) {
      saved.set(v, process.env[v]);
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of RELEVANT_VARS) {
      const orig = saved.get(v);
      if (orig === undefined) delete process.env[v];
      else process.env[v] = orig;
    }
    saved.clear();
    vi.restoreAllMocks();
  });

  it("returns null when no provider env vars are set", () => {
    expect(createEmbeddingFromEnv()).toBeNull();
  });

  describe("Azure activation", () => {
    it("returns an AzureOpenAIEmbeddingAdapter when key + endpoint + deployment are set", () => {
      process.env.AZURE_OPENAI_API_KEY = "azure-k";
      process.env.AZURE_OPENAI_API_ENDPOINT = "https://r.openai.azure.com";
      process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = "embed-deploy";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(AzureOpenAIEmbeddingAdapter);
    });

    it("accepts AZURE_OPENAI_ENDPOINT as a fallback for AZURE_OPENAI_API_ENDPOINT", () => {
      process.env.AZURE_OPENAI_API_KEY = "azure-k";
      process.env.AZURE_OPENAI_ENDPOINT = "https://r.openai.azure.com";
      process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = "embed-deploy";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(AzureOpenAIEmbeddingAdapter);
    });

    it("warns and returns null when key + endpoint are set but deployment is missing", () => {
      process.env.AZURE_OPENAI_API_KEY = "azure-k";
      process.env.AZURE_OPENAI_API_ENDPOINT = "https://r.openai.azure.com";
      // AZURE_OPENAI_EMBED_DEPLOYMENT deliberately not set.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0];
      expect(message).toMatch(/AZURE_OPENAI_EMBED_DEPLOYMENT/);
    });

    it("does not activate when only the key is set (no endpoint)", () => {
      process.env.AZURE_OPENAI_API_KEY = "azure-k";
      process.env.OPENAI_API_KEY = "openai-k";
      // No AZURE_OPENAI_API_ENDPOINT — the compound activation guard
      // should fall through to OpenAI rather than misleadingly using
      // Azure with an undefined endpoint.

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(OpenAICompatibleEmbeddingAdapter);
    });

    it("takes precedence over OPENAI_API_KEY when both are configured", () => {
      // The PR description calls out this ordering as deliberate: an
      // unrelated OPENAI_API_KEY in the environment shouldn't override
      // the explicit Azure compound configuration.
      process.env.AZURE_OPENAI_API_KEY = "azure-k";
      process.env.AZURE_OPENAI_API_ENDPOINT = "https://r.openai.azure.com";
      process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = "embed-deploy";
      process.env.OPENAI_API_KEY = "openai-k";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(AzureOpenAIEmbeddingAdapter);
    });

    it("forwards CHIASMUS_EMBED_DIM and AZURE_OPENAI_API_VERSION to the adapter URL", async () => {
      process.env.AZURE_OPENAI_API_KEY = "azure-k";
      process.env.AZURE_OPENAI_API_ENDPOINT = "https://r.openai.azure.com";
      process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = "embed-deploy";
      process.env.AZURE_OPENAI_API_VERSION = "2024-02-15";
      process.env.CHIASMUS_EMBED_DIM = "256";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(AzureOpenAIEmbeddingAdapter);

      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      try {
        await adapter!.embed(["x"]);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(
          "https://r.openai.azure.com/openai/deployments/embed-deploy/embeddings?api-version=2024-02-15",
        );
        const body = JSON.parse(init.body as string);
        expect(body.dimensions).toBe(256);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("OpenAI fallback", () => {
    it("returns an OpenAICompatibleEmbeddingAdapter when only OPENAI_API_KEY is set", () => {
      process.env.OPENAI_API_KEY = "openai-k";
      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(OpenAICompatibleEmbeddingAdapter);
    });
  });
});
