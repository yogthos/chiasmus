import { describe, it, expect, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRepoKey } from "../../src/graph/cache.js";
import { childEntryFor, type GraphJobMessage, type GraphResultMessage } from "../../src/graph/child-pool.js";

/**
 * The real child entry (graph-child.ts) speaking the pool's protocol. The
 * pool's decisions are tested against a fake child; this checks the real one
 * reports what those decisions read, and runs jobs in the parent's context.
 */
describe("graph-child protocol", () => {
  let child: ChildProcess | null = null;
  let root: string | null = null;

  afterEach(async () => {
    child?.kill("SIGKILL");
    child = null;
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  function start(): { next: () => Promise<GraphResultMessage> } {
    const entry = childEntryFor(new URL("../../src/graph/child-pool.ts", import.meta.url).href, process.execArgv);
    child = fork(entry.path, [String(process.pid)], { execArgv: entry.execArgv, stdio: ["ignore", 2, 2, "ipc"] });
    const inbox: GraphResultMessage[] = [];
    const waiting: Array<(m: GraphResultMessage) => void> = [];
    child.on("message", (m: GraphResultMessage) => {
      const w = waiting.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    return {
      next: () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise((r) => waiting.push(r))),
    };
  }

  function job(id: number, args: Record<string, unknown>, context: Partial<GraphJobMessage> = {}): GraphJobMessage {
    return {
      type: "job",
      id,
      tool: "chiasmus_graph",
      args,
      discoverAdapters: false,
      cwd: process.cwd(),
      env: { ...process.env },
      ...context,
    };
  }

  it("replies with the result, no fatal flag and its own RSS", async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-graph-child-"));
    const file = join(root, "a.ts");
    await writeFile(file, "export function a() { b(); }\nfunction b() {}\n");

    const { next } = start();
    child!.send(job(7, { files: [file], analysis: "summary" }));
    const m = await next();

    expect(m.type).toBe("result");
    expect(m.id).toBe(7);
    expect(m.fatal).toBeUndefined();
    const text = (m.result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).result).toMatchObject({ files: 1, functions: 2 });
    expect(m.rssBytes).toBeGreaterThan(10 * 1024 ** 2);
  }, 60_000);

  it("runs each job in the working directory and environment the parent sent", async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-graph-child-"));
    const project = join(root, "project");
    const cacheDir = join(root, "cache");
    await mkdir(project);
    const file = join(project, "a.ts");
    await writeFile(file, "export function a() { return 1; }\n");

    const { next } = start();
    // The child started without CHIASMUS_CACHE_DIR pointing here, in another directory.
    child!.send(job(1, { files: [file], analysis: "summary", cache: true }, {
      cwd: project,
      env: { ...process.env, CHIASMUS_CACHE_DIR: cacheDir },
    }));
    const m = await next();
    expect(JSON.parse((m.result.content as Array<{ text: string }>)[0].text).result.files).toBe(1);
    // The cache key hashes the working directory, as an inline call would.
    expect(existsSync(join(cacheDir, defaultRepoKey(project), "manifest.json"))).toBe(true);
  }, 60_000);
});
