// Stand-in for src/graph/graph-child.ts speaking the same IPC protocol, so
// GraphChildPool's lifecycle (persistence, recycling, timeouts, queueing,
// cancellation) can be driven deterministically. `args.mode` picks the
// behaviour.
import { appendFileSync } from "node:fs";

let jobs = 0;

function reply(id, payload, extra = {}) {
  process.send({
    type: "result",
    id,
    result: { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, jobs, ...payload }) }] },
    rssBytes: 0,
    ...extra,
  });
}

process.on("disconnect", () => process.exit(0));
process.on("message", async (msg) => {
  if (msg.type !== "job") return;
  jobs++;
  const { mode = "ok", ms = 0, bytes = 0, name, log } = msg.args;
  const startedAt = Date.now();
  switch (mode) {
    case "ok":
      return reply(msg.id, { mode, tool: msg.tool, discoverAdapters: msg.discoverAdapters });
    case "sleep":
      await new Promise((r) => setTimeout(r, ms));
      return reply(msg.id, { mode, startedAt, endedAt: Date.now() });
    case "context":
      return reply(msg.id, { value: msg.env[name] ?? null, cwd: msg.cwd });
    case "crash":
      // `log`: append this process's pid, one line per crash job run.
      if (log) appendFileSync(log, `${process.pid}\n`);
      setImmediate(() => {
        throw new Error("boom");
      });
      return;
    case "exit":
      process.exit(3);
      return;
    case "fatal":
      return reply(msg.id, { error: "memory access out of bounds" }, { fatal: "memory access out of bounds" });
    case "memory":
      return reply(msg.id, { mode }, { rssBytes: bytes });
    case "hang":
      for (;;) {
        // Busy loop: only a signal can stop this.
      }
    case "hang-ignoring-sigterm":
      process.on("SIGTERM", () => {});
      for (;;) {
        // A SIGTERM handler can't run while this loop holds the thread.
      }
    case "oom": {
      const hoard = [];
      for (;;) hoard.push(new Array(1_000_000).fill(hoard.length));
    }
    default:
      return reply(msg.id, { error: `unknown mode ${mode}` });
  }
});
