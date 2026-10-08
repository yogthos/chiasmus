import { describe, it, expect, afterEach, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearAdapters, discoverAdapters } from "../../src/graph/adapter-registry.js";
import {
  GraphChildPool,
  childEntryFor,
  poolOptionsFromEnv,
  runGraphTool,
  shutdownGraphChild,
  type GraphChildPoolOptions,
} from "../../src/graph/child-pool.js";

const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-graph-child.mjs", import.meta.url));

let pools: GraphChildPool[] = [];

function makePool(opts: GraphChildPoolOptions = {}): GraphChildPool {
  const pool = new GraphChildPool({ entry: FAKE_CHILD, execArgv: [], ...opts });
  pools.push(pool);
  return pool;
}

function parse(r: { content: unknown }): any {
  return JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
}

async function run(pool: GraphChildPool, args: Record<string, unknown>): Promise<any> {
  return parse(await pool.run({ tool: "chiasmus_graph", args }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pool's current child process, for fault injection. */
function currentChild(pool: GraphChildPool): ChildProcess {
  return (pool as unknown as { slot: { child: ChildProcess } }).slot.child;
}

afterEach(async () => {
  await Promise.all(pools.map((p) => p.close()));
  pools = [];
});

describe("GraphChildPool", () => {
  it("reuses one persistent child across jobs", async () => {
    const pool = makePool();
    const a = await run(pool, { mode: "ok" });
    const b = await run(pool, { mode: "ok" });
    const c = await run(pool, { mode: "ok" });
    expect(b.pid).toBe(a.pid);
    expect(c.pid).toBe(a.pid);
    expect(pool.pid).toBe(a.pid);
    expect([a.jobs, b.jobs, c.jobs]).toEqual([1, 2, 3]);
  });

  it("forwards the job's tool and adapter-discovery flag", async () => {
    const pool = makePool();
    const r = await pool.run({ tool: "chiasmus_map", args: { mode: "ok" }, discoverAdapters: true });
    const out = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(out).toMatchObject({ tool: "chiasmus_map", discoverAdapters: true });
  });

  it("runs jobs one at a time, in order", async () => {
    const pool = makePool();
    const [a, b] = await Promise.all([
      run(pool, { mode: "sleep", ms: 150 }),
      run(pool, { mode: "sleep", ms: 10 }),
    ]);
    expect(b.pid).toBe(a.pid);
    expect(b.startedAt).toBeGreaterThanOrEqual(a.endedAt);
  });

  it("sends each job the parent's current environment and working directory", async () => {
    const pool = makePool();
    await run(pool, { mode: "ok" });
    // Set after the child started: it must still see it.
    process.env.CHIASMUS_POOL_TEST_VAR = "late";
    try {
      const out = await run(pool, { mode: "context", name: "CHIASMUS_POOL_TEST_VAR" });
      expect(out).toMatchObject({ value: "late", cwd: process.cwd() });
    } finally {
      delete process.env.CHIASMUS_POOL_TEST_VAR;
    }
    expect((await run(pool, { mode: "context", name: "CHIASMUS_POOL_TEST_VAR" })).value).toBeNull();
  });

  it("returns an error result and starts a fresh child after an uncaught crash", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const crashed = await run(pool, { mode: "crash" });
    expect(crashed.error).toBe("graph worker crashed while running chiasmus_graph: exit code 1");
    const after = await run(pool, { mode: "ok" });
    expect(after.pid).not.toBe(before.pid);
    expect(after.jobs).toBe(1);
  });

  it("recovers from the child exiting mid-job", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const exited = await run(pool, { mode: "exit" });
    expect(exited.error).toBe("graph worker crashed while running chiasmus_graph: exit code 3");
    const after = await run(pool, { mode: "ok" });
    expect(after.pid).not.toBe(before.pid);
  });

  it("never reuses a child that reported a fatal WASM error", async () => {
    const pool = makePool();
    const poisoned = await run(pool, { mode: "fatal" });
    // The job's own result is returned unchanged...
    expect(poisoned.error).toBe("memory access out of bounds");
    // ...but the next job must not land on the poisoned instance.
    const next = await run(pool, { mode: "ok" });
    expect(next.pid).not.toBe(poisoned.pid);
    expect(next.jobs).toBe(1);
    // The job resolves before the killed child is reaped; wait for it.
    await vi.waitFor(() => expect(alive(poisoned.pid)).toBe(false), { timeout: 10_000, interval: 50 });
  });

  it("recycles the child after maxJobsPerChild jobs", async () => {
    const pool = makePool({ maxJobsPerChild: 2 });
    const a = await run(pool, { mode: "ok" });
    const b = await run(pool, { mode: "ok" });
    const c = await run(pool, { mode: "ok" });
    expect(b.pid).toBe(a.pid);
    expect(c.pid).not.toBe(a.pid);
    expect(c.jobs).toBe(1);
  });

  it("recycles the child when the RSS it reports after a job is over the cap", async () => {
    const pool = makePool({ maxRssBytes: 1_000 });
    const small = await run(pool, { mode: "memory", bytes: 900 });
    const big = await run(pool, { mode: "memory", bytes: 5_000 });
    const next = await run(pool, { mode: "ok" });
    expect(big.pid).toBe(small.pid);
    expect(next.pid).not.toBe(big.pid);
  });

  it("turns a V8 heap overrun in the child into an error result and a fresh child", async () => {
    const pool = makePool({ heapMb: 32 });
    const before = await run(pool, { mode: "ok" });
    const oom = await run(pool, { mode: "oom" });
    expect(oom.error).toMatch(/^graph worker crashed while running chiasmus_graph: (killed by SIG|exit code)/);
    const after = await run(pool, { mode: "ok" });
    expect(after.pid).not.toBe(before.pid);
  }, 30_000);

  it("kills a job that exceeds the timeout and replaces the child", async () => {
    const pool = makePool({ jobTimeoutMs: 300 });
    const before = await run(pool, { mode: "ok" });
    const hung = await run(pool, { mode: "hang" });
    expect(hung.error).toBe("chiasmus_graph exceeded 300ms and was aborted; the graph worker was restarted");
    const after = await run(pool, { mode: "ok" });
    expect(after.pid).not.toBe(before.pid);
    // The job resolves before the killed child is reaped; wait for it.
    await vi.waitFor(() => expect(alive(before.pid)).toBe(false), { timeout: 10_000, interval: 50 });
  });

  it("bounds the queue and rejects excess jobs immediately", async () => {
    const pool = makePool({ maxQueue: 1 });
    const settled: string[] = [];
    const running = run(pool, { mode: "sleep", ms: 200 }).then((r) => (settled.push("running"), r));
    const queued = run(pool, { mode: "ok" }).then((r) => (settled.push("queued"), r));
    const rejected = await run(pool, { mode: "ok" }).then((r) => (settled.push("rejected"), r));
    expect(rejected.error).toBe("graph worker queue is full (1 jobs waiting); retry later");
    expect((await running).mode).toBe("sleep");
    expect((await queued).mode).toBe("ok");
    // Rejected without waiting for the running job.
    expect(settled).toEqual(["rejected", "running", "queued"]);
  });

  it("drops a queued job whose request was cancelled, without running it", async () => {
    const pool = makePool();
    const running = run(pool, { mode: "sleep", ms: 200 });
    const ac = new AbortController();
    const cancelled = pool.run({ tool: "chiasmus_map", args: { mode: "ok" }, signal: ac.signal });
    ac.abort();
    const r = parse(await cancelled);
    expect(r.error).toBe("chiasmus_map was cancelled by the client");
    await running;
    // The cancelled job never reached the child.
    expect((await run(pool, { mode: "ok" })).jobs).toBe(2);
  });

  it("kills the child of a running job whose request was cancelled, at once", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const ac = new AbortController();
    const job = pool.run({ tool: "chiasmus_graph", args: { mode: "hang" }, signal: ac.signal });
    await sleep(100);
    let settled = false;
    void job.then(() => { settled = true; });
    ac.abort();
    // Resolved by the abort itself, not by any later event from the child
    // (the hung child never answers): settled before the next macrotask.
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(true);
    const r = parse(await job);
    expect(r.error).toBe("chiasmus_graph was cancelled by the client");
    const after = await run(pool, { mode: "ok" });
    expect(after.pid).not.toBe(before.pid);
    // The job resolves before the killed child is reaped; wait for it.
    await vi.waitFor(() => expect(alive(before.pid)).toBe(false), { timeout: 10_000, interval: 50 });
  });

  it("fails a job it cannot hand to the child as an error result, from run() and from a child listener", async () => {
    const pool = makePool();
    // JSON IPC cannot serialize a BigInt, so send() throws synchronously.
    const direct = parse(await pool.run({ tool: "chiasmus_graph", args: { mode: "ok", n: 1n } }));
    expect(direct.error).toMatch(/^graph worker crashed while running chiasmus_graph: could not send the job: .*BigInt/);
    // Queued behind a running job, it is sent from the child's 'message'
    // listener, where a throw is an uncaught exception that kills the server.
    const [a, b] = await Promise.all([
      run(pool, { mode: "sleep", ms: 100 }),
      pool.run({ tool: "chiasmus_graph", args: { mode: "ok", n: 2n } }).then(parse),
    ]);
    expect(a.mode).toBe("sleep");
    expect(b.error).toMatch(/^graph worker crashed while running chiasmus_graph: could not send the job: .*BigInt/);
    expect((await run(pool, { mode: "ok" })).mode).toBe("ok");
  });

  it("fails each job that crashes its child once, without retrying it, and serves the next job on a fresh child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chiasmus-pool-crash-"));
    const log = join(dir, "crashes");
    try {
      const pool = makePool();
      const results = await Promise.all([
        run(pool, { mode: "crash", log }),
        run(pool, { mode: "crash", log }),
        run(pool, { mode: "crash", log }),
        run(pool, { mode: "ok" }),
      ]);
      for (const r of results.slice(0, 3)) {
        expect(r.error).toBe("graph worker crashed while running chiasmus_graph: exit code 1");
      }
      const crashPids = readFileSync(log, "utf8").trim().split("\n").map(Number);
      // One run per crash job, each on its own child.
      expect(crashPids).toHaveLength(3);
      expect(new Set(crashPids).size).toBe(3);
      expect(results[3]).toMatchObject({ mode: "ok", jobs: 1 });
      expect(crashPids).not.toContain(results[3].pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forks no child while a transport close aborts the running job and the jobs queued behind it", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The SDK's Protocol._onclose aborts every in-flight request in arrival
      // order, synchronously.
      const acs = Array.from({ length: 5 }, () => new AbortController());
      const jobs = acs.map((ac, i) => pool.run({
        tool: "chiasmus_graph", args: { mode: i === 0 ? "hang" : "ok" }, signal: ac.signal,
      }));
      // A job queued behind them, from a request that stays open.
      const survivor = run(pool, { mode: "ok" });
      expect(pool.pid).toBe(before.pid);
      for (const ac of acs) {
        ac.abort();
        expect(pool.pid).toBeUndefined();
      }
      for (const r of await Promise.all(jobs)) {
        expect(parse(r).error).toBe("chiasmus_graph was cancelled by the client");
      }
      const after = await survivor;
      expect(after).toMatchObject({ mode: "ok", jobs: 1 });
      expect(after.pid).not.toBe(before.pid);
      const recycled = errors.mock.calls.filter((c) => String(c[0]).includes("recycled (cancelled)"));
      expect(recycled).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("fails the job of a busy child whose IPC channel closed at once, kills the child and replaces it once", async () => {
    // The timeout is what ended the job without a 'disconnect' listener.
    const pool = makePool({ jobTimeoutMs: 5_000 });
    const before = await run(pool, { mode: "ok" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = run(pool, { mode: "hang" });
      await sleep(100);
      // The child is in a busy loop (in production: one long native tree
      // walk), so its own 'disconnect' handler can't run, and its watchdog
      // sees the parent alive.
      const t0 = performance.now();
      currentChild(pool).disconnect();
      const failed = await job;
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(failed.error).toBe("graph worker crashed while running chiasmus_graph: IPC channel closed (killed by SIGKILL)");
      expect(alive(before.pid)).toBe(false);
      const next = await run(pool, { mode: "ok" });
      const again = await run(pool, { mode: "ok" });
      expect(next).toMatchObject({ mode: "ok", jobs: 1 });
      expect(next.pid).not.toBe(before.pid);
      expect(again).toMatchObject({ pid: next.pid, jobs: 2 });
      // Its exit, after the SIGKILL, does not count as a second death.
      expect(errors.mock.calls.filter((c) => String(c[0]).includes("recycled"))).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("takes an idle child whose IPC channel closed out of service before its exit, so the next job gets a fresh one", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const child = currentChild(pool);
    const disconnected = new Promise((r) => child.once("disconnect", r));
    child.disconnect();
    await disconnected;
    // Until the exit is reaped, a job sent to it would fail with "could not send the job".
    expect(pool.pid).toBeUndefined();
    const next = await run(pool, { mode: "ok" });
    expect(next).toMatchObject({ mode: "ok", jobs: 1 });
    expect(next.pid).not.toBe(before.pid);
  });

  it.each([
    ["", 0],
    [", even when the server's event loop stalls between its 'disconnect' and its 'exit'", 300],
  ])("reports a busy child killed from outside (the OOM killer, kill -9) by its signal, not as a closed channel%s", async (_, stallMs) => {
    const pool = makePool({ jobTimeoutMs: 5_000 });
    await run(pool, { mode: "ok" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = run(pool, { mode: "hang" });
      await sleep(100);
      const child = currentChild(pool);
      // Its channel closes as it dies, just before its 'exit'. Synchronous
      // work in the server right then (registered after the pool's listener)
      // holds the 'exit' back past the pool's grace period.
      if (stallMs) {
        child.once("disconnect", () => {
          const end = performance.now() + stallMs;
          while (performance.now() < end) { /* busy */ }
        });
      }
      process.kill(child.pid!, "SIGKILL");
      expect((await job).error).toBe("graph worker crashed while running chiasmus_graph: killed by SIGKILL");
      const recycled = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("recycled"));
      expect(recycled).toEqual(["[Chiasmus] graph worker recycled (crash: killed by SIGKILL)"]);
      expect((await run(pool, { mode: "ok" })).jobs).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("on close, kills a busy child whose IPC channel just closed, logging no crash", async () => {
    const pool = makePool({ jobTimeoutMs: 5_000 });
    const { pid } = await run(pool, { mode: "ok" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = run(pool, { mode: "hang" });
      await sleep(100);
      const child = currentChild(pool);
      const disconnected = new Promise((r) => child.once("disconnect", r));
      child.disconnect();
      await disconnected;
      await pool.close();
      expect(alive(pid)).toBe(false);
      expect((await job).error).toBe("graph worker is shut down");
      expect(errors.mock.calls.filter((c) => String(c[0]).includes("recycled"))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("caps a job timeout too large for setTimeout instead of letting it fire at once", async () => {
    // Over 2^31-1 ms, Node clamps a timer to 1 ms.
    const pool = makePool({ jobTimeoutMs: 99_999_999_999 });
    expect(await run(pool, { mode: "sleep", ms: 300 })).toMatchObject({ mode: "sleep" });
  });

  it("refuses a job whose request was already cancelled", async () => {
    const pool = makePool();
    const r = await pool.run({ tool: "chiasmus_graph", args: { mode: "ok" }, signal: AbortSignal.abort() });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text).error).toBe("chiasmus_graph was cancelled by the client");
  });

  it("releases an idle child after idleTimeoutMs", async () => {
    const pool = makePool({ idleTimeoutMs: 100 });
    const a = await run(pool, { mode: "ok" });
    await vi.waitFor(() => expect(alive(a.pid)).toBe(false), { timeout: 10_000, interval: 50 });
    const b = await run(pool, { mode: "ok" });
    expect(b.pid).not.toBe(a.pid);
  });

  it("fails pending and future jobs on close", async () => {
    const pool = makePool();
    const running = run(pool, { mode: "sleep", ms: 5_000 });
    const queued = run(pool, { mode: "ok" });
    await sleep(50);
    await pool.close();
    expect((await running).error).toBe("graph worker is shut down");
    expect((await queued).error).toBe("graph worker is shut down");
    expect((await run(pool, { mode: "ok" })).error).toBe("graph worker is shut down");
  });

  it("kills a busy child on close, even one that ignores SIGTERM, and waits for its exit", async () => {
    const pool = makePool();
    const pid = (await run(pool, { mode: "ok" })).pid;
    const job = run(pool, { mode: "hang-ignoring-sigterm" });
    await sleep(100);
    const t0 = performance.now();
    await pool.close();
    // A SIGTERM-only close would never return (the test would time out); the
    // bound only rules out a grace period before the SIGKILL, with room for a
    // loaded host.
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(alive(pid)).toBe(false);
    expect((await job).error).toBe("graph worker is shut down");
  });

  it("reports a child that cannot start as an error result", async () => {
    const pool = makePool({ entry: fileURLToPath(new URL("./fixtures/does-not-exist.mjs", import.meta.url)) });
    const r = await run(pool, { mode: "ok" });
    expect(r.error).toBe("graph worker crashed while running chiasmus_graph: exit code 1");
  });

  it("resolves with an error result when fork() throws, and keeps serving", async () => {
    // A NUL byte in an argument makes spawn throw synchronously.
    const pool = makePool({ execArgv: ["--no-warnings\0"] });
    const settled = await Promise.allSettled([run(pool, { mode: "ok" }), run(pool, { mode: "ok" })]);
    for (const s of settled) {
      expect(s.status).toBe("fulfilled");
      if (s.status === "fulfilled") {
        expect(s.value.error).toMatch(/^graph worker could not start for chiasmus_graph: .*null bytes/);
      }
    }
  });
});

describe("childEntryFor", () => {
  it("forks the compiled sibling graph-child.js from dist with the parent's loader flags", () => {
    const entry = childEntryFor("file:///pkg/dist/graph/child-pool.js", ["--enable-source-maps", "--import", "/pkg/otel.mjs"]);
    expect(entry.path).toBe("/pkg/dist/graph/graph-child.js");
    expect(entry.execArgv).toEqual(["--import", "/pkg/otel.mjs"]);
  });

  it("forks the .ts entry through tsx when loaded from source", () => {
    const entry = childEntryFor("file:///pkg/src/graph/child-pool.ts", ["--conditions", "node"]);
    expect(entry.path).toBe("/pkg/src/graph/graph-child.ts");
    expect(entry.execArgv).toEqual(["--conditions", "node", "--import", "tsx"]);
  });

  it("forwards only loader flags (-e, --inspect, --watch or a heap limit must not reach the child)", () => {
    const parent = [
      "-e", "console.log(1)", "--inspect=9229", "--watch", "--max-old-space-size=8192", "--expose-gc",
      "--require", "/pkg/suppress-warnings.cjs", "--conditions", "node", "-C", "development",
      "--import=file:///pkg/hook.mjs",
    ];
    expect(childEntryFor("file:///pkg/src/graph/child-pool.ts", parent).execArgv).toEqual([
      "--require", "/pkg/suppress-warnings.cjs", "--conditions", "node", "-C", "development",
      "--import=file:///pkg/hook.mjs", "--import", "tsx",
    ]);
  });

  it("does not register tsx twice under the tsx CLI", () => {
    const cli = ["--require", "/pkg/node_modules/tsx/dist/preflight.cjs", "--import", "file:///pkg/node_modules/tsx/dist/loader.mjs"];
    expect(childEntryFor("file:///pkg/src/graph/child-pool.ts", cli).execArgv).toEqual(cli);
    // A path that merely contains "tsx" (pnpm store dir names) is not the loader.
    const vitest = ["--require", "/pkg/node_modules/.pnpm/vitest@4_tsx@4.23.13_/node_modules/vitest/x.cjs"];
    expect(childEntryFor("file:///pkg/src/graph/child-pool.ts", vitest).execArgv).toEqual([...vitest, "--import", "tsx"]);
  });

  it("points at a child entry that exists (tsc emits it beside child-pool.js)", () => {
    const entry = childEntryFor(new URL("../../src/graph/child-pool.ts", import.meta.url).href, []);
    expect(existsSync(entry.path)).toBe(true);
  });
});

describe("runGraphTool", () => {
  it("has the child discover adapters once this process has run discovery, whatever the job's flag", async () => {
    const poolRun = vi.spyOn(GraphChildPool.prototype, "run").mockResolvedValue({ content: [] });
    try {
      await runGraphTool({ tool: "chiasmus_graph", args: {}, discoverAdapters: false });
      expect(poolRun.mock.calls[0][0].discoverAdapters).toBe(false);
      // A library user calling the public discoverAdapters(), with
      // config.adapterDiscovery off: inline, those adapters would be used.
      await discoverAdapters();
      await runGraphTool({ tool: "chiasmus_graph", args: {}, discoverAdapters: false });
      expect(poolRun.mock.calls[1][0].discoverAdapters).toBe(true);
    } finally {
      poolRun.mockRestore();
      clearAdapters();
    }
  });

  it("runs inline when CHIASMUS_GRAPH_WORKER=off", async () => {
    const prev = process.env.CHIASMUS_GRAPH_WORKER;
    process.env.CHIASMUS_GRAPH_WORKER = "off";
    try {
      const r = await runGraphTool({ tool: "chiasmus_graph", args: { files: [], analysis: "nope" } });
      const text = (r.content as Array<{ text: string }>)[0].text;
      expect(JSON.parse(text).error).toMatch(/^Unknown analysis: nope/);
    } finally {
      if (prev === undefined) delete process.env.CHIASMUS_GRAPH_WORKER;
      else process.env.CHIASMUS_GRAPH_WORKER = prev;
    }
  });
});

describe("poolOptionsFromEnv", () => {
  it("reads the child heap limit and the job timeout", () => {
    expect(poolOptionsFromEnv({ CHIASMUS_GRAPH_WORKER_HEAP_MB: "512", CHIASMUS_GRAPH_JOB_TIMEOUT_MS: "1500" })).toEqual({
      jobTimeoutMs: 1500,
      heapMb: 512,
    });
  });

  it("keeps the defaults for unset, zero, negative, non-numeric or non-integer values", () => {
    // parseInt would read "1e6" as 1 and "12abc" as 12.
    for (const v of [undefined, "", "0", "-5", "abc", "1e6", "12abc", "1.5", " 7", "0x10", "99999999999999999999"]) {
      const opts = poolOptionsFromEnv({ CHIASMUS_GRAPH_WORKER_HEAP_MB: v, CHIASMUS_GRAPH_JOB_TIMEOUT_MS: v });
      expect(opts.jobTimeoutMs).toBeUndefined();
      expect(opts.heapMb).toBeUndefined();
    }
  });
});

describe("shutdownGraphChild", () => {
  // Runs last in this file: the shared pool stays shut for the process.
  it("refuses later graph jobs instead of starting a new child", async () => {
    await shutdownGraphChild();
    const r = await runGraphTool({ tool: "chiasmus_graph", args: { files: [], analysis: "summary" } });
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).error).toBe("graph worker is shut down");
  });
});
