import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AzureOpenAIEmbeddingAdapter } from "../src/llm/azure-openai.js";

function embeddingResponse(count: number, dim: number): Response {
  const data = Array.from({ length: count }, (_, index) => ({
    index,
    embedding: Array.from({ length: dim }, (_, j) => (index + 1) * (j + 1) * 0.001),
  }));
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AzureOpenAIEmbeddingAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => embeddingResponse(1, 4));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("routes by deployment name and uses the api-key header (not Bearer)", async () => {
    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "test-key",
      endpoint: "https://my-resource.openai.azure.com",
      deployment: "my-embed-deploy",
      apiVersion: "2024-02-01",
    });
    await adapter.embed(["hello"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/my-embed-deploy/embeddings?api-version=2024-02-01",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("omits 'model' from the body — Azure routes by deployment", async () => {
    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    await adapter.embed(["hello"]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("model");
    expect(body.input).toEqual(["hello"]);
  });

  it("defaults to API version 2023-05-15 when none is provided", async () => {
    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    await adapter.embed(["hello"]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api-version=2023-05-15");
  });

  it("strips a trailing slash from the endpoint", async () => {
    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com///",
      deployment: "d",
    });
    await adapter.embed(["hello"]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://r.openai.azure.com/openai/deployments/d/embeddings?api-version=2023-05-15",
    );
  });

  it("forwards a configured dimension via the 'dimensions' field, and omits it otherwise", async () => {
    const withDim = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
      dimension: 256,
    });
    await withDim.embed(["x"]);
    const bodyWithDim = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(bodyWithDim.dimensions).toBe(256);

    fetchMock.mockClear();

    const noDim = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    await noDim.embed(["x"]);
    const bodyNoDim = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(bodyNoDim).not.toHaveProperty("dimensions");
  });

  it("batches at the Azure 16-input limit by default", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return embeddingResponse(body.input.length, 3);
    });

    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    const inputs = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const vecs = await adapter.embed(inputs);

    expect(vecs).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.input).toHaveLength(16);
    expect(secondBody.input).toHaveLength(4);
  });

  it("returns embeddings in input order even when the API responds out of order", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 2, embedding: [0.3] },
            { index: 0, embedding: [0.1] },
            { index: 1, embedding: [0.2] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    const vecs = await adapter.embed(["a", "b", "c"]);
    expect(vecs).toEqual([[0.1], [0.2], [0.3]]);
  });

  it("throws with status and body on a non-2xx response", async () => {
    fetchMock.mockImplementation(async () =>
      new Response("rate limited", { status: 429 }),
    );

    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    await expect(adapter.embed(["x"])).rejects.toThrow(/429/);
    await expect(adapter.embed(["x"])).rejects.toThrow(/rate limited/);
  });

  it("dimension() throws before the first embed when not pre-configured", () => {
    const adapter = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    expect(() => adapter.dimension()).toThrow(/dimension is unknown/);
  });

  it("dimension() returns the configured value, and learns it from the first embed when not configured", async () => {
    const preset = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
      dimension: 8,
    });
    expect(preset.dimension()).toBe(8);

    const learned = new AzureOpenAIEmbeddingAdapter({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com",
      deployment: "d",
    });
    fetchMock.mockImplementationOnce(async () => embeddingResponse(1, 5));
    await learned.embed(["x"]);
    expect(learned.dimension()).toBe(5);
  });
});
