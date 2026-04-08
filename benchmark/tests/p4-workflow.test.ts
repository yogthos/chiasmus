import { describe, it, expect } from "vitest";
import { workflowStates } from "../problems/definitions.js";
import { solveTraditional } from "../traditional/p4-workflow.js";
import { solveChiasmus } from "../chiasmus/p4-workflow.js";

interface WorkflowResult {
  unreachableStates: string[];
  deadEndStates: string[];
}

function runSuite(name: string, solve: (wf: typeof workflowStates) => Promise<WorkflowResult>) {
  describe(name, () => {
    it("identifies 'deleted' as unreachable", async () => {
      const result = await solve(workflowStates);
      expect(result.unreachableStates).toContain("deleted");
    });

    it("identifies 'archived' as a dead-end", async () => {
      const result = await solve(workflowStates);
      expect(result.deadEndStates).toContain("archived");
    });

    it("does not flag reachable states as unreachable", async () => {
      const result = await solve(workflowStates);
      const reachableStates = ["draft", "pending_review", "in_review", "approved",
                                "rejected", "published", "archived"];
      for (const s of reachableStates) {
        expect(result.unreachableStates).not.toContain(s);
      }
    });

    it("does not flag states with outgoing transitions as dead-ends", async () => {
      const result = await solve(workflowStates);
      const hasOutgoing = ["draft", "pending_review", "in_review", "approved",
                           "rejected", "published"];
      for (const s of hasOutgoing) {
        expect(result.deadEndStates).not.toContain(s);
      }
    });
  });
}

describe("Problem 4: Workflow State Machine Validation", () => {
  runSuite("Traditional", solveTraditional);
  runSuite("Chiasmus", solveChiasmus);
});
