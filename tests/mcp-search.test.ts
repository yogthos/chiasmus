import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../src/mcp-server.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("chiasmus_search MCP tool", () => {
  let client: Client;
  let tempDir: string;
  let cleanup: () => Promise<void>;
  let srcDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-search-mcp-"));
    srcDir = join(tempDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, "auth.ts"),
      `/** Refreshes OAuth access tokens. */
       export function refreshOAuthToken() {}
       /** Validates incoming credentials. */
       export function validateCredentials() {}
       /** Computes a SHA-256 hash. */
       export function computeHash() {}`,
    );

    const mockLLM = new MockLLMAdapter();
    const embedAdapter = new MockEmbeddingAdapter({ dimension: 16 });

    const { server, library } = await createChiasmusServer(
      tempDir,
      mockLLM,
      embedAdapter,
    );

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientT);

    cleanup = async () => {
      await client.close();
      await server.close();
      library.close();
      await rm(tempDir, { recursive: true, force: true });
    };
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("is listed in available tools", async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("chiasmus_search");
  });

  it("returns well-formed hits for a query", async () => {
    const r = await client.callTool({
      name: "chiasmus_search",
      arguments: {
        query: "refreshOAuthToken",
        files: [join(srcDir, "auth.ts")],
        top_k: 10,
      },
    });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.hits).toBeDefined();
    expect(parsed.hits.length).toBeGreaterThan(0);
    // Every hit has the expected shape — name, file, line, score in [-1, 1].
    const auth = join(srcDir, "auth.ts");
    for (const hit of parsed.hits) {
      expect(typeof hit.name).toBe("string");
      expect(hit.file).toBe(auth);
      expect(hit.line).toBeGreaterThan(0);
      expect(hit.score).toBeGreaterThanOrEqual(-1);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    // Ranking is monotonic non-increasing.
    for (let i = 1; i < parsed.hits.length; i++) {
      expect(parsed.hits[i - 1].score).toBeGreaterThanOrEqual(parsed.hits[i].score);
    }
    // All corpus entries should surface when topK >= corpus size.
    const names = parsed.hits.map((h: { name: string }) => h.name);
    expect(names).toContain("refreshOAuthToken");
    expect(names).toContain("validateCredentials");
    expect(names).toContain("computeHash");
  });

  it("rejects empty query", async () => {
    const r = await client.callTool({
      name: "chiasmus_search",
      arguments: {
        query: "",
        files: [join(srcDir, "auth.ts")],
      },
    });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).error).toBeDefined();
  });

  it("rejects empty files list", async () => {
    const r = await client.callTool({
      name: "chiasmus_search",
      arguments: { query: "x", files: [] },
    });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).error).toBeDefined();
  });

  it("top_k is clamped to [1, 100]", async () => {
    const r = await client.callTool({
      name: "chiasmus_search",
      arguments: {
        query: "anything",
        files: [join(srcDir, "auth.ts")],
        top_k: 999,
      },
    });
    const parsed = JSON.parse(
      (r.content as Array<{ type: string; text: string }>)[0].text,
    );
    // Only 3 functions in corpus; clamp doesn't add rows but also doesn't error
    expect(parsed.hits.length).toBeLessThanOrEqual(3);
  });
});

describe("chiasmus_search without embedding adapter configured", () => {
  let client: Client;
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-search-noembed-"));
    const mockLLM = new MockLLMAdapter();
    const { server, library } = await createChiasmusServer(
      tempDir,
      mockLLM,
      null, // no embedding adapter
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientT);
    cleanup = async () => {
      await client.close();
      await server.close();
      library.close();
      await rm(tempDir, { recursive: true, force: true });
    };
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("returns an explicit error when no adapter is configured", async () => {
    const r = await client.callTool({
      name: "chiasmus_search",
      arguments: { query: "anything", files: ["/nonexistent.ts"] },
    });
    const parsed = JSON.parse(
      (r.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.error).toMatch(/embedding provider/i);
  });
});
