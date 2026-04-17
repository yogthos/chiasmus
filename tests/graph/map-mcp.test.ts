import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../../src/mcp-server.js";
import { MockLLMAdapter } from "../../src/llm/mock.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("chiasmus_map MCP tool", () => {
  let client: Client;
  let tempDir: string;
  let srcDir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-map-test-"));
    srcDir = join(tempDir, "src");
    await mkdir(srcDir, { recursive: true });

    await writeFile(join(srcDir, "server.ts"), `
/** HTTP entry point — wires routes to handlers. */
import { query } from './db';

export function handleRequest(id: string): Promise<string> {
  validate(id);
  return query(id);
}

function validate(id: string): void {}
    `.trim());

    await writeFile(join(srcDir, "db.ts"), `
export function query(id: string): Promise<string> { return Promise.resolve(id); }
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
    expect(names).toContain("chiasmus_map");
  });

  it("returns overview markdown with exports and signatures", async () => {
    const result = await client.callTool({
      name: "chiasmus_map",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const md = content[0].text;
    expect(md).toMatch(/Codebase overview/i);
    expect(md).toContain("handleRequest");
    expect(md).toContain("query");
    expect(md).toContain("HTTP entry point");
  });

  it("returns file detail JSON with exports and imports", async () => {
    const result = await client.callTool({
      name: "chiasmus_map",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
        mode: "file",
        path: join(srcDir, "server.ts"),
        format: "json",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.kind).toBe("file");
    expect(parsed.exports.map((e: { name: string }) => e.name)).toContain("handleRequest");
    expect(parsed.imports.some((i: { source: string }) => i.source === "./db")).toBe(true);
  });

  it("returns symbol detail JSON with callers and callees", async () => {
    const result = await client.callTool({
      name: "chiasmus_map",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
        mode: "symbol",
        name: "query",
        format: "json",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.kind).toBe("symbol");
    expect(parsed.callers).toContain("handleRequest");
  });

  it("clamps negative max_exports to 0 (returns no topExports, full exportCount)", async () => {
    const result = await client.callTool({
      name: "chiasmus_map",
      arguments: {
        files: [join(srcDir, "server.ts"), join(srcDir, "db.ts")],
        format: "json",
        max_exports: -5,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    for (const f of parsed.files) {
      expect(f.topExports).toEqual([]);
      expect(f.exportCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects mode='file' without path", async () => {
    const result = await client.callTool({
      name: "chiasmus_map",
      arguments: {
        files: [join(srcDir, "server.ts")],
        mode: "file",
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.error).toMatch(/path/);
  });
});
