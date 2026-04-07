import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../src/mcp-server.js";

describe("chiasmus_verify MCP tool", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const server = createChiasmusServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("lists chiasmus_verify in available tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("chiasmus_verify");
  });

  it("verifies satisfiable Z3 SMT-LIB input", async () => {
    const result = await client.callTool({
      name: "chiasmus_verify",
      arguments: {
        solver: "z3",
        input: `
          (declare-const x Int)
          (declare-const y Int)
          (assert (= (+ x y) 10))
          (assert (> x 3))
          (assert (> y 3))
        `,
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("sat");
    expect(parsed.model).toHaveProperty("x");
    expect(parsed.model).toHaveProperty("y");
  });

  it("verifies unsatisfiable Z3 input", async () => {
    const result = await client.callTool({
      name: "chiasmus_verify",
      arguments: {
        solver: "z3",
        input: `
          (declare-const x Int)
          (assert (> x 10))
          (assert (< x 5))
        `,
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("unsat");
  });

  it("verifies Prolog queries", async () => {
    const result = await client.callTool({
      name: "chiasmus_verify",
      arguments: {
        solver: "prolog",
        input: `parent(tom, bob). parent(bob, ann).`,
        query: "parent(tom, X).",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.answers).toHaveLength(1);
    expect(parsed.answers[0].bindings.X).toBe("bob");
  });

  it("returns structured error for malformed Z3 input", async () => {
    const result = await client.callTool({
      name: "chiasmus_verify",
      arguments: {
        solver: "z3",
        input: `(declare-const x Int) (assert (> x "bad"))`,
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBeTruthy();
  });

  it("returns structured error for malformed Prolog input", async () => {
    const result = await client.callTool({
      name: "chiasmus_verify",
      arguments: {
        solver: "prolog",
        input: `parent(tom bob.`,
        query: "parent(tom, X).",
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBeTruthy();
  });

  it("requires query parameter for prolog solver", async () => {
    const result = await client.callTool({
      name: "chiasmus_verify",
      arguments: {
        solver: "prolog",
        input: `parent(tom, bob).`,
        // missing query
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toMatch(/query/i);
  });
});
