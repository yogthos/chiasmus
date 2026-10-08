import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

// A solver WASM abort used to leave the server process running with a broken
// solver module, or hung in it. These run the CLI entry as its own process,
// crash a real solver module through an MCP call, and require exit code 1
// before any answer arrives.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// An oversized query overflows the Emscripten stack and traps the real module
// (see tests/solver-fatal-real.test.ts). The input that traps Z3 that way is
// 24 MiB, over the stdio transport's 10 MiB message limit, so the Z3 trap is
// only covered in process there.
const PROLOG_TRAP_QUERY = `atom_length('${"a".repeat(4_000_000)}', L).`;

// Bit-blasting this factoring problem fills Z3's fixed 2 GiB heap on the
// check's pthread, so Emscripten aborts there ("Cannot enlarge memory
// arrays"): what a solve that runs out of heap does. Takes ~12 s and 2 GiB.
const Z3_OOM_WIDTH = 16384;
const Z3_OOM = `(set-option :timeout 600000)
(declare-const a (_ BitVec ${Z3_OOM_WIDTH}))
(declare-const b (_ BitVec ${Z3_OOM_WIDTH}))
(assert (= (bvmul a b) (_ bv1000003 ${Z3_OOM_WIDTH})))
(assert (bvugt a (_ bv1 ${Z3_OOM_WIDTH})))
(assert (bvugt b (_ bv1 ${Z3_OOM_WIDTH})))`;

type Entry = {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<number | null>;
  stderr: () => string;
};

function startEntry(home: string): Entry {
  // Only PATH and a scratch home: no LLM keys, and no real ~/.chiasmus.
  const child = spawn(process.execPath, ["--import", "tsx", join("src", "mcp-server.ts")], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: home, CHIASMUS_HOME: home },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // Writing to a process that has exited must not fail the test run.
  child.stdin.on("error", () => undefined);
  // "close", not "exit": stderr can still hold the fatal log line when "exit" fires.
  const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return { child, exit, stderr: () => stderr };
}

async function stopEntry(entry: Entry): Promise<void> {
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill("SIGKILL");
  }
  await entry.exit;
}

/** Resolves with the JSON-RPC response to `id` on the child's stdout. */
function stdioResponse(entry: Entry, id: number): Promise<unknown> {
  return new Promise((resolve) => {
    let buffered = "";
    entry.child.stdout.setEncoding("utf8");
    entry.child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { id?: unknown };
          if (message.id === id) resolve(message);
        } catch {
          // Not a JSON-RPC line.
        }
      }
    });
  });
}

async function expectEntryToExit(
  verifyArgs: Record<string, unknown>,
  solver: string,
  detail: string,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-stdio-"));
  const entry = startEntry(home);
  try {
    // A process that survives answers the call; one that exits drops it.
    const answer = stdioResponse(entry, 2);
    const send = (message: object) => entry.child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "entry-fatal-test", version: "0.0.1" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "chiasmus_verify", arguments: verifyArgs },
    });

    const outcome = await Promise.race([
      entry.exit.then((code) => ({ exit: code })),
      answer.then(() => ({ answered: true })),
    ]);

    expect(outcome).toEqual({ exit: 1 });
    expect(entry.stderr()).toContain(`fatal ${solver} WASM error, exiting`);
    expect(entry.stderr()).toContain(detail);
  } finally {
    await stopEntry(entry);
    await rm(home, { recursive: true, force: true });
  }
}

describe("CLI entry exits when a solver module crashes", () => {
  it("exits 1 on a Prolog trap", async () => {
    await expectEntryToExit(
      { solver: "prolog", input: "p(1).", query: PROLOG_TRAP_QUERY },
      "prolog",
      "memory access out of bounds",
    );
  }, 90_000);

  it.runIf(process.env.CHIASMUS_Z3_ABORT_E2E)(
    "exits 1 when a Z3 check aborts out of memory (CHIASMUS_Z3_ABORT_E2E=1)",
    async () => {
      await expectEntryToExit(
        { solver: "z3", input: Z3_OOM },
        "z3",
        "Aborted(Cannot enlarge memory arrays",
      );
    },
    300_000,
  );
});
