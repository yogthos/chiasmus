import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEmbeddingFromEnv } from "../src/llm/anthropic.js";
import { AzureOpenAIEmbeddingAdapter } from "../src/llm/azure-openai.js";
import { OpenAICompatibleEmbeddingAdapter } from "../src/llm/openai-compatible.js";
import { LocalEmbeddingAdapter } from "../src/llm/local-embeddings.js";
import type { ChiasmusConfig } from "../src/config.js";

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
  "CHIASMUS_LOCAL_EMBED",
  "CHIASMUS_LOCAL_EMBED_MODEL",
  "CHIASMUS_LOCAL_EMBED_DIM",
  "CHIASMUS_LOCAL_EMBED_DIR",
  "CHIASMUS_LOCAL_EMBED_BATCH",
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

  describe("OpenRouter fallback", () => {
    it("returns an OpenAICompatibleEmbeddingAdapter when only OPENROUTER_API_KEY is set", () => {
      process.env.OPENROUTER_API_KEY = "or-k";
      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(OpenAICompatibleEmbeddingAdapter);
    });
  });

  describe("DeepSeek (no embeddings API)", () => {
    it("warns and returns null when only DEEPSEEK_API_KEY is set", () => {
      // DeepSeek has no /embeddings endpoint, so it must not be auto-selected
      // for search — doing so produced a confusing 404 / dimension error.
      process.env.DEEPSEEK_API_KEY = "ds-k";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/DeepSeek/);
    });

    it("is honored when CHIASMUS_EMBED_URL points at an embeddings-capable endpoint", () => {
      // An explicit custom URL means the user is routing the DeepSeek key at
      // an OpenAI-compatible embeddings gateway (or local Ollama) — honor it.
      process.env.DEEPSEEK_API_KEY = "ds-k";
      process.env.CHIASMUS_EMBED_URL = "http://localhost:11434/v1";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(OpenAICompatibleEmbeddingAdapter);
    });

    it("does not take precedence over a working OPENROUTER_API_KEY", () => {
      process.env.DEEPSEEK_API_KEY = "ds-k";
      process.env.OPENROUTER_API_KEY = "or-k";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(OpenAICompatibleEmbeddingAdapter);
    });
  });

  describe("local embeddings (node-llama-cpp)", () => {
    it("selects LocalEmbeddingAdapter when enabled + model via env, threading dimension", () => {
      process.env.CHIASMUS_LOCAL_EMBED = "1";
      process.env.CHIASMUS_LOCAL_EMBED_MODEL = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF";
      process.env.CHIASMUS_LOCAL_EMBED_DIM = "1024";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(LocalEmbeddingAdapter);
      expect((adapter as LocalEmbeddingAdapter).dimension()).toBe(1024);
    });

    it("prefers local over an available cloud key when enabled", () => {
      process.env.CHIASMUS_LOCAL_EMBED = "1";
      process.env.CHIASMUS_LOCAL_EMBED_MODEL = "hf:foo/bar";
      process.env.OPENAI_API_KEY = "sk-test";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(LocalEmbeddingAdapter);
    });

    it("uses config-file localEmbeddings when passed (no env)", () => {
      const config: ChiasmusConfig = {
        adapterDiscovery: false,
        localEmbeddings: { enabled: true, model: "hf:cfg/model", dimension: 768 },
      };
      const adapter = createEmbeddingFromEnv(config);
      expect(adapter).toBeInstanceOf(LocalEmbeddingAdapter);
      expect((adapter as LocalEmbeddingAdapter).dimension()).toBe(768);
    });

    it("does not use local when disabled, even with a model set", () => {
      const config: ChiasmusConfig = {
        adapterDiscovery: false,
        localEmbeddings: { enabled: false, model: "hf:foo/bar" },
      };
      const adapter = createEmbeddingFromEnv(config);
      expect(adapter).not.toBeInstanceOf(LocalEmbeddingAdapter);
    });

    it("falls through to a cloud provider when enabled but no model is set", () => {
      process.env.CHIASMUS_LOCAL_EMBED = "1";
      process.env.OPENAI_API_KEY = "sk-test";

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeInstanceOf(OpenAICompatibleEmbeddingAdapter);
    });

    it("warns and returns null when enabled, no model, and no cloud provider", () => {
      process.env.CHIASMUS_LOCAL_EMBED = "1";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = createEmbeddingFromEnv();
      expect(adapter).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/model/i));
    });
  });
});
