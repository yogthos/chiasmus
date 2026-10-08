// Out-of-process driver for child-kill-mid-walk.test.ts. Starts a
// chiasmus_map over a file whose single tree walk takes seconds, then, while
// the walk runs:
//   cancel     aborts the job's signal, then runs more small graph jobs
//   close      shuts the graph pool down
//   hold-busy  prints the graph child's pid and waits to be killed
//   hold-idle  same, after the small warm-up job only
//   disconnect closes the busy child's IPC channel, then runs a small job
//   exit-busy  prints the graph child's pid, then calls process.exit(1)
//              (what the fatal solver-error exit does) once a line arrives
//              on stdin
// It runs in its own process because the failure it guards against is a C++
// abort ("terminate called after throwing an instance of 'Napi::Error'") of
// the whole process, which would take the test runner down with it.
// Usage: graph-job-mid-walk.ts <mode> <small-file> <big-file>
import type { ChildProcess } from "node:child_process";
import { getGraphChildPool, runGraphTool, shutdownGraphChild } from "../../../src/graph/child-pool.js";

const [mode, smallFile, bigFile] = process.argv.slice(2);
const STOP_AFTER_MS = Number(process.env.STOP_AFTER_MS ?? 2_000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0].text;
const small = () => runGraphTool({ tool: "chiasmus_graph", args: { files: [smallFile], analysis: "summary" } });
const childPid = () => (getGraphChildPool() as { pid?: number }).pid;
const report = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Warm-up: graph child started and the TypeScript grammar loaded, so the big
// job below goes straight to parsing.
await small();
if (mode === "hold-idle") {
  report({ childPid: childPid() });
  setInterval(() => {}, 60_000);
} else {
  const ac = new AbortController();
  const big = runGraphTool({ tool: "chiasmus_map", args: { files: [bigFile] }, signal: ac.signal });
  await sleep(STOP_AFTER_MS);
  const busyPid = childPid();

  if (mode === "hold-busy") {
    report({ childPid: busyPid });
    setInterval(() => {}, 60_000);
  } else if (mode === "exit-busy") {
    process.stdin.once("data", () => process.exit(1));
    report({ childPid: busyPid });
  } else if (mode === "cancel") {
    const t0 = performance.now();
    ac.abort();
    const cancelled = text(await big);
    const cancelMs = Math.round(performance.now() - t0);
    const next = text(await small());
    const busyChildGone = !alive(busyPid);
    // Stopping the job sets nothing off later (the worker-thread design
    // called terminate() after a 3 s grace); one more call after a pause
    // checks the process still serves graph calls.
    await sleep(SETTLE_MS);
    const after = text(await small());
    await shutdownGraphChild();
    report({ cancelled, cancelMs, next, after, busyPid, busyChildGone });
  } else if (mode === "disconnect") {
    // Fault injection: close the channel from this side. The child is inside
    // the walk, so its own 'disconnect' handler can't run, and its watchdog
    // sees this process alive.
    const t0 = performance.now();
    (getGraphChildPool() as unknown as { slot: { child: ChildProcess } }).slot.child.disconnect();
    const failed = text(await big);
    const failMs = Math.round(performance.now() - t0);
    const busyChildGone = !alive(busyPid);
    const next = text(await small());
    await shutdownGraphChild();
    report({ failed, failMs, next, busyPid, busyChildGone });
  } else if (mode === "close") {
    const t0 = performance.now();
    await shutdownGraphChild();
    const closeMs = Math.round(performance.now() - t0);
    report({ result: text(await big), closeMs, busyPid });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}
