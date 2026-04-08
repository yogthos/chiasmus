import { describe, it, expect } from "vitest";
import { dataFlowGraph } from "../problems/definitions.js";
import { solveTraditional } from "../traditional/p3-taint.js";
import { solveChiasmus } from "../chiasmus/p3-taint.js";

interface TaintResult {
  reachable: Array<{ source: string; sink: string }>;
  unreachable: string[];
}

function runSuite(name: string, solve: (graph: typeof dataFlowGraph) => Promise<TaintResult>) {
  describe(name, () => {
    it("finds that http_request can reach db_query", async () => {
      const result = await solve(dataFlowGraph);
      const match = result.reachable.find(
        (r) => r.source === "http_request" && r.sink === "db_query"
      );
      expect(match).toBeDefined();
    });

    it("finds that http_request can reach eval_engine", async () => {
      const result = await solve(dataFlowGraph);
      const match = result.reachable.find(
        (r) => r.source === "http_request" && r.sink === "eval_engine"
      );
      expect(match).toBeDefined();
    });

    it("finds that http_request can reach file_write", async () => {
      const result = await solve(dataFlowGraph);
      const match = result.reachable.find(
        (r) => r.source === "http_request" && r.sink === "file_write"
      );
      expect(match).toBeDefined();
    });

    it("all three sinks are reachable", async () => {
      const result = await solve(dataFlowGraph);
      expect(result.reachable.length).toBe(3);
      expect(result.unreachable.length).toBe(0);
    });
  });
}

describe("Problem 3: Data Flow Taint Analysis", () => {
  runSuite("Traditional", solveTraditional);
  runSuite("Chiasmus", solveChiasmus);
});
