import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../../src/mcp-server.js";
import { registerAdapter, clearAdapters } from "../../src/graph/adapter-registry.js";
import { MockLLMAdapter } from "../../src/llm/mock.js";
import { shutdownGraphChild } from "../../src/graph/child-pool.js";
import type { CodeGraph, LanguageAdapter } from "../../src/graph/types.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Python grammar under a custom extension: top-level defs and the calls inside them. */
const pyxAdapter: LanguageAdapter = {
  language: "pyx",
  extensions: [".pyx"],
  grammar: { package: "tree-sitter-python" },
  extract(rootNode, filePath): CodeGraph {
    const defines: CodeGraph["defines"] = [];
    const calls: CodeGraph["calls"] = [];
    for (const fn of rootNode.namedChildren) {
      if (fn.type !== "function_definition") continue;
      const name = fn.childForFieldName("name")?.text;
      if (!name) continue;
      defines.push({ file: filePath, name, kind: "function", line: fn.startPosition.row + 1 });
      const stack = [fn];
      while (stack.length) {
        const n = stack.pop();
        if (n.type === "call") {
          const callee = n.childForFieldName("function");
          if (callee?.type === "identifier") calls.push({ caller: name, callee: callee.text });
        }
        stack.push(...n.namedChildren);
      }
    }
    return { defines, calls, imports: [], exports: [], contains: [] };
  },
};

/**
 * chiasmus_graph / chiasmus_map run in a child process, which has its own
 * adapter registry. Adapters registered in code with the public
 * registerAdapter() can't be sent there (their extract() is a function), so
 * their files used to drop out of the result without any error.
 */
describe("graph tools with adapters registered in code (MCP)", () => {
  let client: Client;
  let root: string;
  let file: string;
  let cleanup: () => Promise<void>;

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-child-adapters-"));
    file = join(root, "mod.pyx");
    await writeFile(file, "def main():\n    helper()\n\ndef helper():\n    return 1\n");

    registerAdapter(pyxAdapter);
    const mockLLM = new MockLLMAdapter();
    mockLLM.onMatch(/./, "mock");
    const { server, library } = await createChiasmusServer(root, mockLLM);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
      library.close();
      await shutdownGraphChild();
    };
  });

  afterAll(async () => {
    try {
      await cleanup?.();
    } finally {
      clearAdapters();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chiasmus_graph extracts files handled by a registered adapter", async () => {
    const out = await call("chiasmus_graph", { files: [file], analysis: "summary" });
    expect(out.result).toMatchObject({ files: 1, functions: 2, callEdges: 1 });
  });

  it("chiasmus_map lists files handled by a registered adapter", async () => {
    const out = await call("chiasmus_map", { files: [file], format: "json" });
    expect(JSON.stringify(out)).toContain("mod.pyx");
    expect(out.summary).toMatchObject({ files: 1 });
  });
});
