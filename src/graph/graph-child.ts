/**
 * Child-process entry for chiasmus_graph / chiasmus_map (see child-pool.ts).
 * Runs the jobs the parent sends, one at a time, and replies with the result,
 * whether the job left web-tree-sitter in a fatal state, and this process's
 * RSS, so the parent can decide whether to reuse it. The parent stops a job
 * by killing this process; nothing here needs a clean exit.
 *
 * argv[2] is the parent's PID.
 */

import { Worker } from "node:worker_threads";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { discoverAdapters } from "./adapter-registry.js";
import { wasmFailure } from "./parser.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import type { GraphJobMessage, GraphResultMessage } from "./child-pool.js";

if (!process.send) throw new Error("graph-child must be started with child_process.fork()");
const parentPid = Number(process.argv[2]);

function send(message: GraphResultMessage): void {
  // The channel only closes when the parent is gone.
  process.send!(message, undefined, undefined, (err: Error | null) => {
    if (err) process.exit(0);
  });
}

// This process must not outlive the parent. When the parent dies its end of
// the IPC channel closes: an idle child gets 'disconnect' and exits. A busy
// one would only see it once its current synchronous step returns (one tree
// walk can take seconds, an analysis minutes), so a watchdog thread checks
// for the parent every 500 ms and SIGKILLs this process once it is gone. On
// POSIX a dead parent shows as a changed ppid (the child is re-parented); on
// Windows ppid stays put, so the watchdog also probes the parent's PID.
process.on("disconnect", () => process.exit(0));
const WATCHDOG = `
const { workerData: { parentPid } } = require("node:worker_threads");
function parentGone() {
  if (process.ppid !== parentPid) return true;
  try {
    process.kill(parentPid, 0);
    return false;
  } catch {
    return true;
  }
}
setInterval(() => { if (parentGone()) process.kill(process.pid, "SIGKILL"); }, 500);
`;
if (Number.isInteger(parentPid) && parentPid > 0) {
  new Worker(WATCHDOG, { eval: true, workerData: { parentPid }, execArgv: [] }).unref();
}

/** Run the job in the parent's working directory and environment, as an inline call would. */
function adoptParentContext(msg: GraphJobMessage): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in msg.env)) delete process.env[key];
  }
  Object.assign(process.env, msg.env);
  if (msg.cwd) process.chdir(msg.cwd);
}

async function runJob(msg: GraphJobMessage): Promise<void> {
  let result: CallToolResult;
  try {
    adoptParentContext(msg);
    if (msg.discoverAdapters) await discoverAdapters();
    result = msg.tool === "chiasmus_map" ? await handleMap(msg.args) : await handleGraph(msg.args);
  } catch (e) {
    // The handlers catch their own errors; this is a last-resort net with
    // the same `{ error }` shape.
    result = { content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
  }
  send({
    type: "result",
    id: msg.id,
    result,
    fatal: wasmFailure() ?? undefined,
    rssBytes: process.memoryUsage.rss(),
  });
}

process.on("message", (msg: GraphJobMessage) => {
  if (msg?.type === "job") void runJob(msg);
});
