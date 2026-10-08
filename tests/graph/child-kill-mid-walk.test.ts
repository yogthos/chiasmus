import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_SIZE } from "../../src/graph/analyses.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DRIVER = fileURLToPath(new URL("./fixtures/graph-job-mid-walk.ts", import.meta.url));
const SERVER = fileURLToPath(new URL("../../src/mcp-server.ts", import.meta.url));
const ABORT = /Napi::Error|terminate called/;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Proc {
  pid: number;
  /** Exit status and all output; waits until every holder of the stdio pipes has closed them. */
  exited: Promise<Exit>;
  /** The process itself has exited (its children may still hold its stdio pipes). */
  gone: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Next stdout line that parses as JSON. */
  nextJson(): Promise<any>;
  send(message: unknown): void;
}

/** Graph calls need no LLM or embedding provider; keep the child from seeing any. */
function graphOnlyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/API_KEY|^AZURE_/.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

/** `node --import tsx <args>` from the repo root, its stdout read as JSON lines. */
function start(args: string[], env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: REPO_ROOT, env });
  let stdout = "";
  let stderr = "";
  let buffered = "";
  const parsed: any[] = [];
  const waiting: Array<(v: any) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiting.shift();
      if (waiter) waiter(value);
      else parsed.push(value);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<Exit>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const gone = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid!,
    exited,
    gone,
    nextJson: () => (parsed.length > 0
      ? Promise.resolve(parsed.shift())
      : new Promise((resolve) => waiting.push(resolve))),
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
  };
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

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  return !alive(pid);
}

/** Polls `probe` until it returns a value; throws after `ms`. */
async function until<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Whether `pid` is running or runnable (ps state R): busy with a job, not waiting on IPC. */
function busy(pid: number): boolean {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("R");
  } catch {
    return false;
  }
}

/** Direct children of `pid` (`ps -A -o pid=,ppid=` works on Linux and macOS). */
function childrenOf(pid: number): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
  return out.split("\n").flatMap((line) => {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    return pp === pid ? [p] : [];
  });
}

/**
 * A single tree-sitter walk can outlast any cooperative stop: one TypeScript
 * file of 90,000 small functions (6.5 MB, under MAX_FILE_SIZE) walks for
 * seconds without a point where a cancel flag could be checked. Stopping
 * graph work while it is inside native tree-sitter must never take the
 * server down. With the graph tools on a worker thread, worker.terminate()
 * there made node-addon-api's Napi::Error escape and the whole process abort
 * (SIGABRT). The graph child is a separate process and is simply killed.
 * POSIX only: the checks use ps, signals and orphan re-parenting.
 */
describe.skipIf(process.platform === "win32")("stopping a graph job mid-walk", () => {
  let root: string;
  let smallFile: string;
  let bigFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-mid-walk-"));
    smallFile = join(root, "warm.ts");
    bigFile = join(root, "large.ts");
    await writeFile(smallFile, "export function warm() { return 1; }\n");
    let src = "";
    for (let i = 0; i < 90_000; i++) {
      src += `export function f${i}(a: number): number { return g(a) + h(a, ${i}); }\n`;
    }
    expect(Buffer.byteLength(src)).toBeLessThan(MAX_FILE_SIZE);
    await writeFile(bigFile, src);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cancelling the job keeps the process alive and serving graph calls", async () => {
    const r = await start([DRIVER, "cancel", smallFile, bigFile], graphOnlyEnv()).exited;
    expect(r.stderr).not.toMatch(ABORT);
    expect({ code: r.code, signal: r.signal }).toEqual({ code: 0, signal: null });
    const report = JSON.parse(r.stdout.trim());
    expect(JSON.parse(report.cancelled).error).toBe("chiasmus_map was cancelled by the client");
    // The walk had seconds left; the bound only rules out waiting for it.
    expect(report.cancelMs).toBeLessThan(5_000);
    expect(JSON.parse(report.next).result.files).toBe(1);
    expect(JSON.parse(report.after).result.files).toBe(1);
    // The cancelled job's process was gone before the next job ran.
    expect(report.busyChildGone).toBe(true);
  }, 30_000);

  it("closing the pool exits the process cleanly", async () => {
    const r = await start([DRIVER, "close", smallFile, bigFile], graphOnlyEnv()).exited;
    expect(r.stderr).not.toMatch(ABORT);
    expect({ code: r.code, signal: r.signal }).toEqual({ code: 0, signal: null });
    const report = JSON.parse(r.stdout.trim());
    expect(JSON.parse(report.result).error).toMatch(/shut down/);
    expect(report.closeMs).toBeLessThan(5_000);
    if (report.busyPid !== undefined) expect(alive(report.busyPid)).toBe(false);
  }, 30_000);

  it("a busy child whose IPC channel closed is killed at once, failing only its job", async () => {
    const r = await start([DRIVER, "disconnect", smallFile, bigFile], graphOnlyEnv()).exited;
    expect(r.stderr).not.toMatch(ABORT);
    expect({ code: r.code, signal: r.signal }).toEqual({ code: 0, signal: null });
    const report = JSON.parse(r.stdout.trim());
    expect(JSON.parse(report.failed).error).toBe(
      "graph worker crashed while running chiasmus_map: IPC channel closed (killed by SIGKILL)",
    );
    // The walk had seconds left, and the job timeout is 10 min; the bound
    // only rules out waiting for either.
    expect(report.failMs).toBeLessThan(5_000);
    expect(report.busyChildGone).toBe(true);
    expect(JSON.parse(report.next).result.files).toBe(1);
    // Replaced once: the killed child's exit is not a second death.
    expect(r.stderr.match(/graph worker recycled/g)).toHaveLength(1);
  }, 30_000);

  it("SIGTERM to the MCP server exits it cleanly and leaves no graph process behind", async () => {
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const server = start([SERVER], graphOnlyEnv({ CHIASMUS_HOME: home, CHIASMUS_CACHE_DIR: join(root, "cache") }));
    const pending = new Map<number, (m: any) => void>();
    void (async () => {
      for (;;) {
        const m = await server.nextJson();
        pending.get(m.id)?.(m);
      }
    })();
    const request = (id: number, method: string, params: unknown) => {
      const reply = new Promise<any>((resolve) => pending.set(id, resolve));
      server.send({ jsonrpc: "2.0", id, method, params });
      return reply;
    };
    let graphProcs: number[] = [];
    try {
      await request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mid-walk-test", version: "0" },
      });
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const warm = await request(2, "tools/call", {
        name: "chiasmus_graph",
        arguments: { files: [smallFile], analysis: "summary" },
      });
      expect(JSON.parse(warm.result.content[0].text).result.files).toBe(1);

      void request(3, "tools/call", { name: "chiasmus_map", arguments: { files: [bigFile] } });
      // Two more graph calls wait behind it.
      for (const id of [4, 5]) {
        void request(id, "tools/call", { name: "chiasmus_graph", arguments: { files: [smallFile], analysis: "summary" } });
      }
      graphProcs = await until(() => {
        const kids = childrenOf(server.pid);
        return kids.some(busy) ? kids : undefined;
      }, 20_000, "the graph child to start the big job");
      expect(graphProcs.length).toBeGreaterThan(0);
      await sleep(1_000);

      process.kill(server.pid, "SIGTERM");
      const r = await server.exited;
      expect(r.stderr).not.toMatch(ABORT);
      // setupShutdownHandlers exits with 128 + SIGTERM.
      expect({ code: r.code, signal: r.signal }).toEqual({ code: 143, signal: null });
      // Closing the transport aborts the running call and the two queued
      // ones in one loop: the busy child is killed, and no child is forked
      // for a queued call only to be killed by the next abort.
      expect(r.stderr.match(/graph worker recycled \(cancelled\)/g)).toHaveLength(1);
      for (const pid of graphProcs) expect(await waitGone(pid, 10_000)).toBe(true);
    } finally {
      if (alive(server.pid)) process.kill(server.pid, "SIGKILL");
      for (const pid of graphProcs) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 30_000);

  it("the graph process exits when its parent is SIGKILLed mid-job", async () => {
    const parent = start([DRIVER, "hold-busy", smallFile, bigFile], graphOnlyEnv({ STOP_AFTER_MS: "1500" }));
    let childPid: number | undefined;
    try {
      ({ childPid } = await parent.nextJson());
      expect(alive(childPid!)).toBe(true);
      process.kill(parent.pid, "SIGKILL");
      await parent.gone;
      // The child is inside one long tree walk, with seconds left; it must
      // not run on as an orphan until the walk ends.
      expect(await waitGone(childPid!, 5_000)).toBe(true);
    } finally {
      if (alive(parent.pid)) process.kill(parent.pid, "SIGKILL");
      if (childPid !== undefined && alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  }, 30_000);

  it("process.exit() mid-walk kills the graph process without waiting for its watchdog", async () => {
    // The fatal solver-error exit is a plain process.exit(1). The busy child
    // is stopped first, so neither its IPC 'disconnect' handler nor its
    // watchdog thread can run: only the parent's exit can end it.
    const parent = start([DRIVER, "exit-busy", smallFile, bigFile], graphOnlyEnv({ STOP_AFTER_MS: "1500" }));
    let childPid: number | undefined;
    try {
      ({ childPid } = await parent.nextJson());
      await until(() => (busy(childPid!) ? true : undefined), 10_000, "the graph child to be busy");
      process.kill(childPid!, "SIGSTOP");
      parent.send("exit");
      expect(await parent.gone).toEqual({ code: 1, signal: null });
      expect(await waitGone(childPid!, 5_000)).toBe(true);
    } finally {
      if (alive(parent.pid)) process.kill(parent.pid, "SIGKILL");
      if (childPid !== undefined && alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  }, 30_000);

  it("an idle graph process exits when its parent is SIGKILLed", async () => {
    const parent = start([DRIVER, "hold-idle", smallFile, bigFile], graphOnlyEnv());
    let childPid: number | undefined;
    try {
      ({ childPid } = await parent.nextJson());
      expect(alive(childPid!)).toBe(true);
      process.kill(parent.pid, "SIGKILL");
      await parent.gone;
      expect(await waitGone(childPid!, 10_000)).toBe(true);
    } finally {
      if (alive(parent.pid)) process.kill(parent.pid, "SIGKILL");
      if (childPid !== undefined && alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  }, 30_000);
});
