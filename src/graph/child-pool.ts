/**
 * Runs chiasmus_graph / chiasmus_map jobs in a persistent child process
 * (graph-child.ts), so tree-sitter extraction and graph analysis never block
 * the MCP server (other tool calls, pings, cancellation), and so a job can
 * always be stopped: the child is killed with SIGKILL. A worker thread can't
 * be stopped like that — worker.terminate() while the thread is inside
 * native tree-sitter makes node-addon-api's Napi::Error escape and aborts the
 * whole process. A child process dies alone, native crashes included.
 *
 * One child at a time, fed by a bounded FIFO queue — the work is CPU-bound,
 * so a second child would only contend. The child is kept between jobs
 * (grammars stay loaded) and killed, to be started again by the next job,
 * when:
 *   - it crashes or exits (a V8 heap overrun included), or its IPC channel
 *     closes,
 *   - it reports a fatal WASM error (web-tree-sitter state is then
 *     undefined),
 *   - a job runs past the job timeout,
 *   - a running job's request is cancelled (a queued one is just dropped),
 *   - its RSS after a job is over the cap (web-tree-sitter's WASM heap only
 *     grows, and native tree-sitter memory goes back to the OS only when the
 *     process exits),
 *   - it has served maxJobsPerChild jobs, or sits idle past idleTimeoutMs.
 *
 * The child never outlives this process: an exit through process.exit()
 * SIGKILLs it from an 'exit' listener, and the child's watchdog thread
 * covers a parent that dies without running one (SIGKILL, a native crash).
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import { discoveryStarted, hasCodeRegisteredAdapters } from "./adapter-registry.js";

export type GraphTool = "chiasmus_graph" | "chiasmus_map";

export interface GraphJob {
  tool: GraphTool;
  args: Record<string, unknown>;
  /** Run chiasmus-adapter-* discovery in the child before the job (config.adapterDiscovery). */
  discoverAdapters?: boolean;
  /** The MCP request's signal: a cancelled job is dropped if queued, killed if running. */
  signal?: AbortSignal;
}

/** parent → child */
export interface GraphJobMessage {
  type: "job";
  id: number;
  tool: GraphTool;
  args: Record<string, unknown>;
  discoverAdapters: boolean;
  /**
   * The parent's working directory and environment when the job starts. The
   * child adopts them first, so the job sees what an inline call would:
   * defaultRepoKey() hashes the working directory, and the cache location
   * comes from CHIASMUS_CACHE_DIR or HOME.
   */
  cwd?: string;
  env: Record<string, string | undefined>;
}

/** child → parent */
export interface GraphResultMessage {
  type: "result";
  id: number;
  result: CallToolResult;
  /** Set when the job hit a fatal WASM error: the child must not be reused. */
  fatal?: string;
  /** The child's RSS after the job. */
  rssBytes: number;
}

export interface GraphChildPoolOptions {
  /** Jobs allowed to wait behind the running one before new jobs are rejected. */
  maxQueue?: number;
  /** Replace the child after it has served this many jobs. */
  maxJobsPerChild?: number;
  /** Kill the child when a job runs longer than this. */
  jobTimeoutMs?: number;
  /** Kill an idle child after this long (frees its memory). */
  idleTimeoutMs?: number;
  /** Replace the child when its RSS after a job exceeds this. */
  maxRssBytes?: number;
  /**
   * V8 old-generation limit of the child (--max-old-space-size), in MiB.
   * Unset, the child gets Node's default, or NODE_OPTIONS', like the server.
   */
  heapMb?: number;
  /** Child entry module path. Defaults to graph-child.js beside this module. */
  entry?: string;
  /** Node flags for the child. Defaults to the parent's loader flags, plus tsx when running from source. */
  execArgv?: string[];
}

const DEFAULTS = {
  maxQueue: 32,
  maxJobsPerChild: 100,
  jobTimeoutMs: 10 * 60_000,
  idleTimeoutMs: 5 * 60_000,
  maxRssBytes: 2 * 1024 ** 3,
};

/** setTimeout's limit (2^31-1 ms, about 24.8 days): Node turns a longer delay into 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long a child whose IPC channel closed gets to exit on its own before it
 * is SIGKILLed (onDisconnect). A dying child's channel closes just before its
 * 'exit': at most 0.13 ms apart over 305 crashes, exits and outside SIGKILLs
 * on Linux, five of them of a child holding a 2.4 GB heap.
 */
const DISCONNECT_GRACE_MS = 100;

type RecycleReason = "crash" | "fatal-wasm" | "timeout" | "cancelled" | "memory" | "max-jobs" | "idle" | "shutdown";

interface Slot {
  child: ChildProcess;
  jobs: number;
  /** Out of service and SIGKILLed, its loss handled: its exit changes nothing. */
  retired: boolean;
  /** Its IPC channel closed while in service: out of service until it exits, or is killed (onDisconnect). */
  disconnectTimer?: NodeJS.Timeout;
  /** Still running when the grace period after its channel closed ran out, and SIGKILLed for it. */
  disconnected: boolean;
  exited: Promise<void>;
}

interface Pending {
  id: number;
  job: GraphJob;
  resolve: (r: CallToolResult) => void;
  /** Child the job was assigned to, once running. */
  slot?: Slot;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

function cancelledResult(job: GraphJob): CallToolResult {
  return errorResult(`${job.tool} was cancelled by the client`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Flags (with their values) a child needs to load its entry: module loaders and resolve conditions. */
const LOADER_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C"]);

/**
 * The loader flags in `execArgv`. The rest of the parent's flags must not
 * reach the child: `-e`/`-p` would make it run that code instead of its
 * entry, `--inspect` would clash on the debugger port, `--watch` or
 * `--test` would change what it runs, and its heap limit is its own.
 */
function loaderFlags(execArgv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    const eq = arg.indexOf("=");
    if (!LOADER_FLAGS.has(eq === -1 ? arg : arg.slice(0, eq))) continue;
    if (eq !== -1) out.push(arg);
    else if (i + 1 < execArgv.length) out.push(arg, execArgv[++i]);
  }
  return out;
}

/**
 * Child entry for a pool module at `moduleUrl`. The compiled entry sits next
 * to it in dist/. Under tsx or vitest the module is the .ts source, so the
 * entry is too, and the child needs tsx's loader.
 */
export function childEntryFor(moduleUrl: string, execArgv: string[]): { path: string; execArgv: string[] } {
  const loaders = loaderFlags(execArgv);
  if (!moduleUrl.endsWith(".ts")) {
    return { path: fileURLToPath(new URL("./graph-child.js", moduleUrl)), execArgv: loaders };
  }
  // The `tsx` CLI passes its loader as .../tsx/dist/{preflight.cjs,loader.mjs}.
  const hasTsx = loaders.some((a) => a === "tsx" || /[\\/]tsx[\\/]dist[\\/]/.test(a));
  return {
    path: fileURLToPath(new URL("./graph-child.ts", moduleUrl)),
    execArgv: hasTsx ? loaders : [...loaders, "--import", "tsx"],
  };
}

function currentCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // The directory was removed; the child keeps its own.
    return undefined;
  }
}

/** Hold the parent's event loop open for this child (a job in flight, a kill not yet reaped) or not (idle). */
function setRef(slot: Slot, on: boolean): void {
  if (on) {
    slot.child.ref();
    slot.child.channel?.ref();
  } else {
    slot.child.unref();
    slot.child.channel?.unref();
  }
}

export class GraphChildPool {
  private readonly opts: Required<Omit<GraphChildPoolOptions, "entry" | "execArgv" | "heapMb">>;
  private readonly entry: string;
  private readonly execArgv: string[];
  private slot: Slot | null = null;
  private queue: Pending[] = [];
  private active: Pending | null = null;
  private jobTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private closed = false;
  /** Exits of killed children not seen yet; close() waits for them. */
  private readonly dying = new Set<Promise<void>>();
  /** Children out of service since their IPC channel closed, not yet retired (onDisconnect). */
  private readonly unplugged = new Set<Slot>();

  constructor(options: GraphChildPoolOptions = {}) {
    this.opts = {
      maxQueue: options.maxQueue ?? DEFAULTS.maxQueue,
      maxJobsPerChild: options.maxJobsPerChild ?? DEFAULTS.maxJobsPerChild,
      jobTimeoutMs: Math.min(options.jobTimeoutMs ?? DEFAULTS.jobTimeoutMs, MAX_TIMER_MS),
      idleTimeoutMs: Math.min(options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs, MAX_TIMER_MS),
      maxRssBytes: options.maxRssBytes ?? DEFAULTS.maxRssBytes,
    };
    const entry = options.entry
      ? { path: options.entry, execArgv: [] }
      : childEntryFor(import.meta.url, process.execArgv);
    this.entry = entry.path;
    this.execArgv = [
      ...(options.execArgv ?? entry.execArgv),
      ...(options.heapMb ? [`--max-old-space-size=${options.heapMb}`] : []),
    ];
  }

  /** PID of the current child process, if one is running. */
  get pid(): number | undefined {
    return this.slot?.child.pid;
  }

  /** Queue a job. Never rejects: failures come back as `{ error }` tool results. */
  run(job: GraphJob): Promise<CallToolResult> {
    if (this.closed) return Promise.resolve(errorResult("graph worker is shut down"));
    if (job.signal?.aborted) return Promise.resolve(cancelledResult(job));
    if (this.active && this.queue.length >= this.opts.maxQueue) {
      return Promise.resolve(errorResult(
        `graph worker queue is full (${this.queue.length} jobs waiting); retry later`,
      ));
    }
    return new Promise((resolve) => {
      const pending: Pending = { id: this.nextId++, job, resolve };
      const signal = job.signal;
      if (signal) {
        const onAbort = () => this.cancel(pending);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.resolve = (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve(r);
        };
      }
      this.queue.push(pending);
      this.pump();
    });
  }

  /**
   * Fail queued and running jobs, refuse new jobs, kill the child and wait
   * until every killed child has exited, so a shutdown leaves no process
   * behind.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    this.clearJobTimer();
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    for (const p of pending) p.resolve(errorResult("graph worker is shut down"));
    if (this.slot) this.retire(this.slot, "shutdown");
    for (const slot of this.unplugged) this.retire(slot, "shutdown");
    await Promise.all(this.dying);
  }

  /**
   * Start the next queued job. Never throws: pump() also runs from child
   * listeners and timers, where a throw would be an uncaught exception in
   * the server.
   */
  private pump(): void {
    if (this.active || this.closed) return;
    const next = this.queue.shift();
    if (!next) {
      this.armIdleTimer();
      return;
    }
    this.clearIdleTimer();
    let slot: Slot;
    try {
      slot = this.slot ?? this.spawn();
    } catch (e) {
      next.resolve(errorResult(`graph worker could not start for ${next.job.tool}: ${messageOf(e)}`));
      this.pump();
      return;
    }
    next.slot = slot;
    this.active = next;
    setRef(slot, true);
    this.jobTimer = setTimeout(() => this.onTimeout(slot), this.opts.jobTimeoutMs);
    this.jobTimer.unref();
    // A child that has not attached its listener yet gets the job queued
    // (Node holds IPC messages until a 'message' listener exists).
    const msg: GraphJobMessage = {
      type: "job",
      id: next.id,
      tool: next.job.tool,
      args: next.job.args,
      discoverAdapters: next.job.discoverAdapters ?? false,
      cwd: currentCwd(),
      env: { ...process.env },
    };
    try {
      slot.child.send(msg, (err: Error | null) => {
        if (err) this.onDeath(slot, `could not send the job: ${err.message}`);
      });
    } catch (e) {
      // A message that can't be serialized throws here; the child is
      // replaced like after any other failed send.
      this.onDeath(slot, `could not send the job: ${messageOf(e)}`);
    }
  }

  private spawn(): Slot {
    const child = fork(this.entry, [String(process.pid)], {
      execArgv: this.execArgv,
      // The parent's stdout may be the MCP stdio transport: anything the
      // child prints goes to stderr instead.
      stdio: ["ignore", 2, 2, "ipc"],
      serialization: "json",
    });
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const slot: Slot = { child, jobs: 0, retired: false, disconnected: false, exited };
    child.on("message", (m: GraphResultMessage) => this.onMessage(slot, m));
    child.on("disconnect", () => this.onDisconnect(slot));
    child.on("exit", (code, signal) => {
      markExited();
      const status = signal ? `killed by ${signal}` : `exit code ${code}`;
      this.onDeath(slot, slot.disconnected && signal === "SIGKILL" ? `IPC channel closed (${status})` : status);
    });
    // Spawn failures emit 'error' without a following 'exit'.
    child.on("error", (e) => {
      if (child.pid === undefined) markExited();
      this.onDeath(slot, e.message);
    });
    if (!child.connected) {
      // fork() out of file descriptors (EMFILE/ENFILE): Node returns a child
      // with no process and no IPC channel (no send()), and emits 'error' on
      // the next tick, which the listener above takes.
      slot.retired = true;
      throw new Error("fork() set up no IPC channel (out of file descriptors: EMFILE/ENFILE)");
    }
    // The child must not outlive this process. process.exit() (the fatal
    // solver-error exit, a signal handler's exit) runs 'exit' listeners
    // synchronously, so the child is killed there: a busy one would not see
    // the IPC channel close, and would run on until its watchdog noticed the
    // parent was gone. The listener goes once the child has exited, or has
    // turned out never to have started: a spawn failure such as ENOENT or
    // EACCES returns a connected child with no pid that emits 'error' and
    // never 'exit'.
    const killOnExit = (): void => {
      child.kill("SIGKILL");
    };
    process.on("exit", killOnExit);
    void exited.then(() => process.off("exit", killOnExit));
    this.slot = slot;
    return slot;
  }

  private onMessage(slot: Slot, m: GraphResultMessage): void {
    const done = this.active;
    if (slot.retired || m?.type !== "result" || !done || done.slot !== slot || m.id !== done.id) return;
    this.clearJobTimer();
    this.active = null;
    slot.jobs++;
    if (m.fatal) this.retire(slot, "fatal-wasm", m.fatal);
    else if (m.rssBytes > this.opts.maxRssBytes) this.retire(slot, "memory", `${Math.round(m.rssBytes / 1024 ** 2)} MiB RSS`);
    else if (slot.jobs >= this.opts.maxJobsPerChild) this.retire(slot, "max-jobs");
    else setRef(slot, false);
    done.resolve(m.result);
    this.pump();
  }

  /**
   * The child's IPC channel closed. It closes as a child dies, just before
   * the 'exit' that says why; in a live child it closes only if either side
   * disconnects it, and a busy child would not notice that before its current
   * synchronous step (one tree walk) returns, nor would its watchdog, which
   * only looks for the parent. Either way no job can reach it and no result
   * can come back: take it out of service at once, so the next job forks a
   * fresh child. A dying child's 'exit' follows within the grace period and
   * goes through onDeath() with its own exit code or signal (a crash, the
   * OOM killer, kill -9). One still running then is SIGKILLed, and its 'exit'
   * fails its job as a closed channel. The check waits for one more poll of
   * the event loop after the timer, so an 'exit' held back by synchronous
   * work in the server is seen first. A retired child's channel closes
   * because the pool killed it: nothing to do.
   */
  private onDisconnect(slot: Slot): void {
    if (slot.retired || slot.disconnectTimer) return;
    this.outOfService(slot);
    this.unplugged.add(slot);
    slot.disconnectTimer = setTimeout(() => setImmediate(() => {
      if (slot.retired) return;
      slot.disconnected = true;
      slot.child.kill("SIGKILL");
    }), DISCONNECT_GRACE_MS);
    slot.disconnectTimer.unref();
  }

  /** Unplanned loss of a child (crash, exit, failed send). */
  private onDeath(slot: Slot, detail: string): void {
    if (slot.retired) return;
    this.retire(slot, "crash", detail);
    const failed = this.active;
    if (!failed || failed.slot !== slot) return;
    this.clearJobTimer();
    this.active = null;
    failed.resolve(errorResult(`graph worker crashed while running ${failed.job.tool}: ${detail}`));
    this.pump();
  }

  /**
   * The job's request was cancelled (client cancellation or disconnect):
   * drop it if still queued; if running, kill its child, so the next job
   * doesn't wait behind work nobody will read.
   *
   * The next job starts on a later turn of the event loop. When the
   * transport closes, the SDK aborts every in-flight request in one
   * synchronous loop, in arrival order: starting the next job at once would
   * fork a child for each queued job, only for the next abort to kill it.
   */
  private cancel(p: Pending): void {
    const queued = this.queue.indexOf(p);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      p.resolve(cancelledResult(p.job));
      return;
    }
    if (this.active !== p || !p.slot) return;
    this.clearJobTimer();
    this.active = null;
    this.retire(p.slot, "cancelled");
    p.resolve(cancelledResult(p.job));
    setImmediate(() => this.pump());
  }

  private onTimeout(slot: Slot): void {
    const timedOut = this.active;
    // The job's child, out of service once its channel closed, until its exit.
    if (!timedOut || timedOut.slot !== slot) return;
    this.jobTimer = null;
    this.active = null;
    this.retire(slot, "timeout");
    timedOut.resolve(errorResult(
      `${timedOut.job.tool} exceeded ${this.opts.jobTimeoutMs}ms and was aborted; the graph worker was restarted`,
    ));
    this.pump();
  }

  /**
   * Take a child out of service and SIGKILL it. Never a softer signal: the
   * child holds nothing that needs a clean exit (cache files are written to
   * a temp file and renamed into place, and a cache lock it held goes stale),
   * and a busy child would not run a SIGTERM handler before its current
   * synchronous step — one tree walk, one analysis — returns.
   */
  private retire(slot: Slot, reason: RecycleReason, detail?: string): void {
    if (slot.retired) return;
    slot.retired = true;
    if (reason !== "idle" && reason !== "shutdown" && reason !== "max-jobs") {
      console.error(`[Chiasmus] graph worker recycled (${reason}${detail ? `: ${detail}` : ""})`);
    }
    this.kill(slot);
  }

  /** Out of service, SIGKILLed, and its exit awaited by close(). */
  private kill(slot: Slot): void {
    this.outOfService(slot);
    clearTimeout(slot.disconnectTimer);
    this.unplugged.delete(slot);
    slot.child.kill("SIGKILL");
  }

  /** No job goes to it from now on, and close() waits for its exit. */
  private outOfService(slot: Slot): void {
    if (this.slot === slot) this.slot = null;
    // Keep the event loop alive until the exit is reaped, so close() can wait for it.
    setRef(slot, true);
    const exited = slot.exited;
    if (this.dying.has(exited)) return;
    this.dying.add(exited);
    void exited.then(() => this.dying.delete(exited));
  }

  private armIdleTimer(): void {
    const slot = this.slot;
    if (!slot || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.slot === slot && !this.active) this.retire(slot, "idle");
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearJobTimer(): void {
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = null;
  }
}

/** A string of digits only, as a positive safe integer; anything else (parseInt reads "1e6" as 1) is undefined. */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Pool limits from CHIASMUS_GRAPH_WORKER_HEAP_MB and
 * CHIASMUS_GRAPH_JOB_TIMEOUT_MS; unset or invalid values keep the defaults.
 * A timeout over 2^31-1 ms (about 24.8 days) is capped there.
 */
export function poolOptionsFromEnv(env: NodeJS.ProcessEnv): GraphChildPoolOptions {
  return {
    jobTimeoutMs: positiveInt(env.CHIASMUS_GRAPH_JOB_TIMEOUT_MS),
    heapMb: positiveInt(env.CHIASMUS_GRAPH_WORKER_HEAP_MB),
  };
}

/** CHIASMUS_GRAPH_WORKER=0|off|false runs graph tools in the server process. */
function childDisabled(): boolean {
  const v = process.env.CHIASMUS_GRAPH_WORKER?.toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

let shared: GraphChildPool | null = null;

/** The process-wide pool: one graph child per process, shared by every server created in it. */
export function getGraphChildPool(): GraphChildPool {
  shared ??= new GraphChildPool(poolOptionsFromEnv(process.env));
  return shared;
}

/**
 * Run a graph tool job in the graph child — or inline when the child is
 * disabled, or when adapters were registered in code in this process: the
 * child has its own registry and cannot load them, so their files would
 * silently drop out of the result. Once this process has run adapter
 * discovery (config.adapterDiscovery, or a library caller's own
 * discoverAdapters()), the child runs it too, whatever the job's flag, so
 * it sees the adapters an inline call would.
 */
export function runGraphTool(job: GraphJob): Promise<CallToolResult> {
  if (childDisabled() || hasCodeRegisteredAdapters()) {
    return job.tool === "chiasmus_map" ? handleMap(job.args) : handleGraph(job.args);
  }
  return getGraphChildPool().run({ ...job, discoverAdapters: job.discoverAdapters || discoveryStarted() });
}

/**
 * Kill the shared graph child and refuse graph jobs from then on; called on
 * server shutdown. The closed pool stays in place, so a call arriving while
 * the server drains gets an error instead of starting a fresh child.
 */
export async function shutdownGraphChild(): Promise<void> {
  await getGraphChildPool().close();
}
