import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../../src/mcp-server.js";
import { MockLLMAdapter } from "../../src/llm/mock.js";
import { shutdownGraphChild } from "../../src/graph/child-pool.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A snapshot saved from one tree must answer a diff run on another: a
 * baseline saved from a `git archive` extract of the merge-base (a plain
 * directory, no .git) and diffed against the PR's worktree. The graph child
 * process must key the cache the way an inline call does — by the server's
 * working directory, not by each tree's location.
 */
describe("graph snapshot saved from another tree (MCP)", () => {
  let client: Client;
  let root: string;
  let prevCacheDir: string | undefined;
  let cleanup: () => Promise<void>;

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    return JSON.parse(text);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-cross-tree-"));
    prevCacheDir = process.env.CHIASMUS_CACHE_DIR;
    process.env.CHIASMUS_CACHE_DIR = join(root, "cache");

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
      if (prevCacheDir === undefined) delete process.env.CHIASMUS_CACHE_DIR;
      else process.env.CHIASMUS_CACHE_DIR = prevCacheDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("diffs a git worktree against a baseline saved from a plain directory", async () => {
    const baseline = join(root, "baseline", "src");
    const worktree = join(root, "repo");
    await mkdir(baseline, { recursive: true });
    await mkdir(join(worktree, ".git"), { recursive: true });
    await writeFile(join(worktree, ".git", "HEAD"), "ref: refs/heads/feature\n");
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(baseline, "a.ts"), "export function alpha() { beta(); }\nfunction beta() {}\n");
    await writeFile(join(worktree, "src", "a.ts"), "export function alpha() { beta(); gamma(); }\nfunction beta() {}\nfunction gamma() {}\n");

    const saved = await call("chiasmus_graph", {
      files: [join(baseline, "a.ts")],
      analysis: "summary",
      cache: true,
      save_snapshot: "merge-base",
    });
    expect(saved.warnings).toBeUndefined();

    const diff = await call("chiasmus_graph", {
      files: [join(worktree, "src", "a.ts")],
      analysis: "diff",
      against: "merge-base",
      cache: true,
    });
    expect(diff.result.error).toBeUndefined();
    expect(diff.result.addedNodes).toContain("gamma");
  });
});
