import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../../src/mcp-server.js";
import { runAnalysis, MAX_FILE_SIZE } from "../../src/graph/analyses.js";
import { MockLLMAdapter } from "../../src/llm/mock.js";
import { GraphChildPool, shutdownGraphChild, type GraphJob } from "../../src/graph/child-pool.js";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * chiasmus_graph / chiasmus_map used to run tree-sitter extraction and graph
 * analysis in the server process: one big call stalled every other request —
 * other tool calls, pings and cancellation included — for its whole duration.
 * They now run in a child process; the server must stay responsive.
 */
describe("graph tools run outside the server process", () => {
  let client: Client;
  let root: string;
  let corpus: string[];
  let small: string[];
  let oversized: string;
  let cleanup: () => Promise<void>;

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return (r.content as Array<{ type: string; text: string }>)[0].text;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-child-offload-"));

    // ~200 files x 40 functions: several seconds of extraction in-process.
    corpus = [];
    let s = 1;
    const rnd = (n: number) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s % n;
    };
    const FILES = 200;
    const FNS = 40;
    for (let f = 0; f < FILES; f++) {
      let src = `/** Module ${f}. */\nimport { helper } from "./m${(f + 1) % FILES}";\n`;
      for (let i = 0; i < FNS; i++) {
        src += `export function f${f}_${i}(a: number, b: string): number {\n`;
        for (let c = 0; c < 4; c++) src += `  const v${c} = f${rnd(FILES)}_${rnd(FNS)}(a + ${c}, b);\n`;
        src += "  return v0 + v1 + helper(a);\n}\n";
      }
      const p = join(root, `m${f}.ts`);
      await writeFile(p, src);
      corpus.push(p);
    }

    small = [join(root, "server.ts"), join(root, "db.ts"), join(root, "util.ts")];
    await writeFile(small[0], `import { query } from './db';
export function handleRequest() { validate(); query(); }
function validate() { helper(); }
`);
    await writeFile(small[1], `import { helper } from './util';
export function query() { connect(); helper(); }
function connect() { query(); }
function unusedHelper() {}
`);
    await writeFile(small[2], "export function helper() { return 1; }\n");

    // Sparse file over the size cap: no real bytes on disk.
    oversized = join(root, "huge.ts");
    await writeFile(oversized, "");
    await truncate(oversized, MAX_FILE_SIZE + 1);

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
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the event loop responsive while a heavy chiasmus_map runs", async () => {
    // A 10ms ticker; lag is the overshoot of each gap between ticks,
    // including the gap still open when the job returns.
    let maxLag = 0;
    let ticks = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
      ticks++;
    }, 10);
    const t0 = performance.now();
    let text: string;
    try {
      text = await call("chiasmus_map", { files: corpus });
    } finally {
      clearInterval(timer);
    }
    const end = performance.now();
    maxLag = Math.max(maxLag, end - last - 10);
    const jobMs = end - t0;

    expect(text).toContain("# Codebase overview");
    expect(text).toContain(`**Files:** ${corpus.length}`);
    // In-process the ticker cannot fire until the whole extraction is done,
    // so the lag equals the job time and only a tick or two land. In the child
    // the lag is scheduler noise. Both bounds are relative to the job time,
    // which stretches with host load like the noise does.
    expect(maxLag).toBeLessThan(jobMs / 2);
    expect(ticks).toBeGreaterThan(jobMs / 100);
  }, 60_000);

  it("returns byte-identical chiasmus_graph results to in-process analysis", async () => {
    const requests: Array<Record<string, unknown>> = [
      { analysis: "summary" },
      { analysis: "callers", target: "helper" },
      { analysis: "impact", target: "query" },
      { analysis: "cycles" },
      { analysis: "dead-code" },
      { analysis: "hubs" },
      { analysis: "bridges" },
      { analysis: "communities" },
      { analysis: "facts", include_insights: true },
    ];
    for (const req of requests) {
      const viaTool = await call("chiasmus_graph", { files: small, ...req });
      const direct = await runAnalysis(small, {
        analysis: req.analysis as never,
        target: req.target as string | undefined,
        includeInsights: req.include_insights as boolean | undefined,
      });
      expect(viaTool).toBe(JSON.stringify(direct));
    }
  });

  it("applies the MAX_FILE_SIZE guard and reports unreadable files", async () => {
    const graph = JSON.parse(await call("chiasmus_graph", {
      files: [...small, oversized, join(root, "missing.ts")],
      analysis: "summary",
    }));
    expect(graph.result.files).toBe(3);
    expect(graph.warnings).toEqual([
      `Skipped ${oversized}: file exceeds ${MAX_FILE_SIZE} bytes`,
      expect.stringMatching(/^Skipped .*missing\.ts: ENOENT/),
    ]);

    const map = await call("chiasmus_map", { files: [...small, oversized] });
    expect(map).toContain(`- Skipped ${oversized}: file exceeds ${MAX_FILE_SIZE} bytes`);
  });

  it("returns handler errors as tool results", async () => {
    expect(JSON.parse(await call("chiasmus_graph", { files: small, analysis: "nope" })).error)
      .toMatch(/^Unknown analysis: nope\. Use one of: summary, /);
    expect(JSON.parse(await call("chiasmus_map", { files: small, mode: "file" })).error)
      .toBe("mode='file' requires 'path' (absolute file path)");
    expect(JSON.parse(await call("chiasmus_map", { files: [join(root, "missing.ts")] })).error)
      .toBe("No files could be read");
  });

  it("hands the request's abort signal to the pool, which drops the cancelled job", async () => {
    const runSpy = vi.spyOn(GraphChildPool.prototype, "run");
    try {
      const ac = new AbortController();
      const big = client.callTool({ name: "chiasmus_map", arguments: { files: corpus } }, undefined, {
        signal: ac.signal,
        timeout: 120_000,
      });
      await vi.waitFor(() => expect(runSpy).toHaveBeenCalled());
      const job = runSpy.mock.calls[0][0] as GraphJob;
      expect(job.signal).toBeInstanceOf(AbortSignal);
      ac.abort();
      await expect(big).rejects.toThrow();
      // The client's notifications/cancelled reaches the server's signal.
      await vi.waitFor(() => expect(job.signal!.aborted).toBe(true));
      const result = await runSpy.mock.results[0].value;
      expect(JSON.parse(result.content[0].text).error).toBe("chiasmus_map was cancelled by the client");
    } finally {
      runSpy.mockRestore();
    }
    // The pool moves on to the next call.
    expect(JSON.parse(await call("chiasmus_graph", { files: small, analysis: "summary" })).result.files).toBe(3);
  }, 60_000);

  it("serves concurrent graph calls", async () => {
    const results = await Promise.all([
      call("chiasmus_graph", { files: small, analysis: "summary" }),
      call("chiasmus_map", { files: small, format: "json" }),
      call("chiasmus_graph", { files: small, analysis: "callees", target: "handleRequest" }),
    ]);
    expect(JSON.parse(results[0]).result.files).toBe(3);
    expect(JSON.parse(results[1]).summary).toBeDefined();
    expect(JSON.parse(results[2]).result).toEqual(expect.arrayContaining(["validate", "query"]));
  });
});
