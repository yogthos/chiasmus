import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../src/mcp-server.js";
import { MockLLMAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillLibrary } from "../src/skills/library.js";

describe("Chiasmus MCP Server", () => {
  let client: Client;
  let library: SkillLibrary;
  let tempDir: string;
  let mockLLM: MockLLMAdapter;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-mcp-test-"));
    mockLLM = new MockLLMAdapter();
    mockLLM.onMatch(/./, `
(declare-const x Int)
(declare-const y Int)
(assert (= (+ x y) 10))
(assert (> x 0))
(assert (> y 0))
    `.trim());

    const { server, library: lib } = await createChiasmusServer(tempDir, mockLLM);
    library = lib;

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

  describe("chiasmus_verify", () => {
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
      const parsed = JSON.parse(content[0].text);
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
    });

    it("requires query parameter for prolog solver", async () => {
      const result = await client.callTool({
        name: "chiasmus_verify",
        arguments: {
          solver: "prolog",
          input: `parent(tom, bob).`,
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.status).toBe("error");
      expect(parsed.error).toMatch(/query/i);
    });
  });

  describe("chiasmus_skills", () => {
    it("lists chiasmus_skills in available tools", async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("chiasmus_skills");
    });

    it("searches for templates by query", async () => {
      const result = await client.callTool({
        name: "chiasmus_skills",
        arguments: {
          query: "check if access control policies conflict",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].template.name).toBe("policy-contradiction");
    });

    it("gets a template by exact name", async () => {
      const result = await client.callTool({
        name: "chiasmus_skills",
        arguments: {
          name: "graph-reachability",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.template.name).toBe("graph-reachability");
      expect(parsed.template.solver).toBe("prolog");
    });

    it("lists all templates when no query or name given", async () => {
      const result = await client.callTool({
        name: "chiasmus_skills",
        arguments: {},
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(8); // 5 Z3 + 3 Prolog starters
    });

    it("filters by solver type", async () => {
      const result = await client.callTool({
        name: "chiasmus_skills",
        arguments: {
          solver: "prolog",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
      for (const item of parsed) {
        expect(item.template.solver).toBe("prolog");
      }
    });

    it("returns error for unknown template name", async () => {
      const result = await client.callTool({
        name: "chiasmus_skills",
        arguments: {
          name: "nonexistent-template",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.error).toMatch(/not found/i);
    });
  });

  describe("chiasmus_formalize", () => {
    it("lists chiasmus_formalize in available tools", async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("chiasmus_formalize");
    });

    it("returns template and instructions for a problem", async () => {
      const result = await client.callTool({
        name: "chiasmus_formalize",
        arguments: {
          problem: "Check if access control rules can ever conflict",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.template).toBe("policy-contradiction");
      expect(parsed.solver).toBe("z3");
      expect(parsed.instructions).toContain("SLOT");
    });

    it("returns error when problem is missing", async () => {
      const result = await client.callTool({
        name: "chiasmus_formalize",
        arguments: {},
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.error).toMatch(/problem/i);
    });
  });

  describe("chiasmus_solve", () => {
    it("lists chiasmus_solve in available tools", async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("chiasmus_solve");
    });

    it("solves a problem end-to-end with mock LLM", async () => {
      const result = await client.callTool({
        name: "chiasmus_solve",
        arguments: {
          problem: "Find two positive integers that add to 10",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.converged).toBe(true);
      expect(parsed.result.status).toBe("sat");
      expect(parsed.templateUsed).toBeTruthy();
    });

    it("returns error when problem is missing", async () => {
      const result = await client.callTool({
        name: "chiasmus_solve",
        arguments: {},
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.error).toMatch(/problem/i);
    });
  });
});
