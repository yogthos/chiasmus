import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../../src/mcp-server.js";
import { MockLLMAdapter } from "../../src/llm/mock.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("chiasmus_graph MCP tool", () => {
  let client: Client;
  let tempDir: string;
  let srcDir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-graph-test-"));
    srcDir = join(tempDir, "src");
    await mkdir(srcDir, { recursive: true });

    // Write test source files
    await writeFile(join(srcDir, "server.ts"), `
import { query } from './db';
export function handleRequest() { validate(); query(); }
function validate() {}
    `.trim());

    await writeFile(join(srcDir, "db.ts"), `
export function query() { connect(); }
function connect() {}
function unusedHelper() {}
    `.trim());

    const mockLLM = new MockLLMAdapter();
    mockLLM.onMatch(/./, "mock");
    const { server, library } = await createChiasmusServer(tempDir, mockLLM);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

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

  it("appears in tool list", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("chiasmus_graph");
  });

  it("returns callers via MCP", async () => {
    const result = await client.callTool({
      name: "chiasmus_graph",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
        analysis: "callers",
        target: "query",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.analysis).toBe("callers");
    expect(parsed.result).toContain("handleRequest");
  });

  it("returns summary with correct counts", async () => {
    const result = await client.callTool({
      name: "chiasmus_graph",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
        analysis: "summary",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.result.files).toBe(2);
    expect(parsed.result.functions).toBeGreaterThan(0);
    expect(parsed.result.callEdges).toBeGreaterThan(0);
  });

  it("returns dead code analysis", async () => {
    const result = await client.callTool({
      name: "chiasmus_graph",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
        analysis: "dead-code",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.analysis).toBe("dead-code");
    // unusedHelper should be detected as dead code
    expect(parsed.result).toContain("unusedHelper");
  });

  it("returns error for missing parameters", async () => {
    const result = await client.callTool({
      name: "chiasmus_graph",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.error).toBeTruthy();
  });

  it("returns a clean error when files contains non-string elements", async () => {
    const result = await client.callTool({
      name: "chiasmus_graph",
      arguments: {
        files: [join(srcDir, "server.ts"), 42, null],
        analysis: "summary",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.error).toBeTruthy();
    expect(String(parsed.error)).toMatch(/files/i);
  });

  it("returns facts as raw Prolog", async () => {
    const result = await client.callTool({
      name: "chiasmus_graph",
      arguments: {
        files: [join(srcDir, "server.ts")],
        analysis: "facts",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.analysis).toBe("facts");
    expect(parsed.result).toContain("defines(");
    expect(parsed.result).toContain("calls(");
  });
});
