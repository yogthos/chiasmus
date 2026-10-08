import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

/**
 * When fork() runs out of file descriptors (EMFILE/ENFILE), Node returns a
 * ChildProcess with no process and no IPC channel — no send() at all — and
 * emits 'error' on the next tick. The pool must turn that into an error
 * result for the job: pump() also runs from child listeners and timers,
 * where a throw is an uncaught exception that takes the server down.
 */
const forks = vi.hoisted(() => ({ outOfFds: 0, noExecutable: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>) => {
      if (forks.noExecutable > 0) {
        // A real spawn failure (ENOENT): Node returns a connected child with
        // no pid, emits 'error' and never 'exit'. EACCES and EAGAIN do the same.
        forks.noExecutable--;
        const [modulePath, forkArgs, options] = args as [string, readonly string[], object];
        return actual.fork(modulePath, forkArgs, { ...options, execPath: "/nonexistent/chiasmus-test/node" });
      }
      if (forks.outOfFds === 0) return actual.fork(...args);
      forks.outOfFds--;
      return outOfFdsChild();
    },
  };
});

/** What Node's ChildProcess.spawn() leaves behind on EMFILE: no pid, not connected, no send(). */
function outOfFdsChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    connected: false,
    ref() {},
    unref() {},
    kill: () => false,
  });
  process.nextTick(() => {
    const err = Object.assign(new Error("spawn node EMFILE"), { code: "EMFILE", errno: -24, syscall: "spawn node" });
    child.emit("error", err);
  });
  return child as unknown as ChildProcess;
}

const { GraphChildPool } = await import("../../src/graph/child-pool.js");

const FAKE_CHILD = fileURLToPath(new URL("./fixtures/fake-graph-child.mjs", import.meta.url));

let pools: InstanceType<typeof GraphChildPool>[] = [];

function makePool(opts: ConstructorParameters<typeof GraphChildPool>[0] = {}) {
  const pool = new GraphChildPool({ entry: FAKE_CHILD, execArgv: [], ...opts });
  pools.push(pool);
  return pool;
}

async function run(pool: InstanceType<typeof GraphChildPool>, args: Record<string, unknown>): Promise<any> {
  const r = await pool.run({ tool: "chiasmus_graph", args });
  return JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
}

afterEach(async () => {
  forks.outOfFds = 0;
  forks.noExecutable = 0;
  await Promise.all(pools.map((p) => p.close()));
  pools = [];
});

describe("GraphChildPool when fork() is out of file descriptors", () => {
  it("resolves the job with an error result and keeps serving", async () => {
    const pool = makePool();
    forks.outOfFds = 1;
    const r = await run(pool, { mode: "ok" });
    expect(r.error).toMatch(/^graph worker could not start for chiasmus_graph: .*(EMFILE|file descriptors)/);
    expect(await run(pool, { mode: "ok" })).toMatchObject({ mode: "ok", jobs: 1 });
  });

  it("does not throw from the result listener when replacing a recycled child fails", async () => {
    const pool = makePool({ maxJobsPerChild: 1 });
    const first = run(pool, { mode: "sleep", ms: 200 });
    const queued = run(pool, { mode: "ok" });
    // The first job's child is up; the replacement forked after its result
    // (max-jobs recycle, from the child's 'message' listener) gets EMFILE.
    forks.outOfFds = 1;
    expect((await first).mode).toBe("sleep");
    expect((await queued).error).toMatch(/^graph worker could not start for chiasmus_graph: .*(EMFILE|file descriptors)/);
    expect(await run(pool, { mode: "ok" })).toMatchObject({ mode: "ok", jobs: 1 });
  });

  it("close() returns at once when the last fork failed", async () => {
    const pool = makePool();
    forks.outOfFds = 1;
    await run(pool, { mode: "ok" });
    await pool.close();
    expect(pool.pid).toBeUndefined();
  });
});

describe("GraphChildPool when fork() can't start the process", () => {
  it("resolves the job with an error result, keeps serving and leaves no process 'exit' listener behind", async () => {
    const listeners = process.listenerCount("exit");
    const pool = makePool();
    forks.noExecutable = 1;
    const r = await run(pool, { mode: "ok" });
    expect(r.error).toMatch(/^graph worker crashed while running chiasmus_graph: .*ENOENT/);
    // The kill-on-exit listener of a child that never started must not stay
    // registered: one per failed graph call would pile up.
    await vi.waitFor(() => expect(process.listenerCount("exit")).toBe(listeners));

    expect(await run(pool, { mode: "ok" })).toMatchObject({ mode: "ok", jobs: 1 });
    await pool.close();
    expect(process.listenerCount("exit")).toBe(listeners);
  });
});
