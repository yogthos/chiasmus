import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupShutdownHandlers } from "../src/mcp-server.js";
import { GraphChildPool } from "../src/graph/child-pool.js";

describe("setupShutdownHandlers", () => {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let processOn: ReturnType<typeof vi.spyOn>;
  let processOff: ReturnType<typeof vi.spyOn>;
  let processExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processOn = vi.spyOn(process, "on") as any;
    processOff = vi.spyOn(process, "removeListener") as any;
    processExit = vi.spyOn(process, "exit").mockImplementation(((
      _code?: number,
    ) => undefined) as any);
  });

  afterEach(() => {
    processOn.mockRestore();
    processOff.mockRestore();
    processExit.mockRestore();
  });

  it("registers SIGINT and SIGTERM handlers", () => {
    const library = { close: vi.fn() };
    const server = { close: vi.fn(async () => undefined) };

    setupShutdownHandlers(server as any, library as any);

    const registered = processOn.mock.calls.map((c) => c[0]);
    for (const sig of signals) {
      expect(registered).toContain(sig);
    }
  });

  it("invokes library.close() when a signal is received", async () => {
    const library = { close: vi.fn() };
    const server = { close: vi.fn(async () => undefined) };

    setupShutdownHandlers(server as any, library as any);

    // Grab the SIGINT handler that was just registered and invoke it
    const call = processOn.mock.calls.find((c) => c[0] === "SIGINT");
    expect(call).toBeDefined();
    const handler = call![1] as (sig: NodeJS.Signals) => Promise<void> | void;
    await handler("SIGINT");

    expect(library.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(processExit).toHaveBeenCalled();
  });

  it("handler does not throw if library.close throws", async () => {
    const library = {
      close: vi.fn(() => {
        throw new Error("db already closed");
      }),
    };
    const server = { close: vi.fn(async () => undefined) };

    setupShutdownHandlers(server as any, library as any);
    const handler = processOn.mock.calls.find((c) => c[0] === "SIGTERM")![1] as (
      sig: NodeJS.Signals,
    ) => Promise<void> | void;

    await expect(Promise.resolve(handler("SIGTERM"))).resolves.not.toThrow();
    expect(processExit).toHaveBeenCalled();
  });

  it("waits for the graph child process to be killed before exiting", async () => {
    let release!: () => void;
    const close = vi.spyOn(GraphChildPool.prototype, "close")
      .mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const library = { close: vi.fn() };
      const server = { close: vi.fn(async () => undefined) };

      setupShutdownHandlers(server as any, library as any);
      const handler = processOn.mock.calls.find((c) => c[0] === "SIGTERM")![1] as (
        sig: NodeJS.Signals,
      ) => Promise<void> | void;
      const done = Promise.resolve(handler("SIGTERM"));

      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(processExit).not.toHaveBeenCalled();
      release();
      await done;
      expect(processExit).toHaveBeenCalledWith(143);
    } finally {
      close.mockRestore();
    }
  });

  it("still exits if killing the graph child process fails", async () => {
    const close = vi.spyOn(GraphChildPool.prototype, "close")
      .mockRejectedValue(new Error("child did not exit"));
    try {
      const library = { close: vi.fn() };
      const server = { close: vi.fn(async () => undefined) };

      setupShutdownHandlers(server as any, library as any);
      const handler = processOn.mock.calls.find((c) => c[0] === "SIGTERM")![1] as (
        sig: NodeJS.Signals,
      ) => Promise<void> | void;

      await expect(Promise.resolve(handler("SIGTERM"))).resolves.not.toThrow();
      expect(close).toHaveBeenCalledOnce();
      expect(processExit).toHaveBeenCalledWith(143);
    } finally {
      close.mockRestore();
    }
  });
});
