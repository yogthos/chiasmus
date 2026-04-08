import { describe, it, expect } from "vitest";
import { classifyFeedback } from "../src/formalize/feedback.js";
import type { SolverResult } from "../src/solvers/types.js";

describe("classifyFeedback", () => {
  it("classifies error result", () => {
    const result: SolverResult = { status: "error", error: "type mismatch at line 3" };
    const feedback = classifyFeedback(result);
    expect(feedback).toContain("type mismatch");
  });

  it("classifies unsat result with core", () => {
    // Forward-compatible: unsatCore may exist once Phase 1 merges
    const result = { status: "unsat" as const, unsatCore: ["gt10", "lt5"] };
    const feedback = classifyFeedback(result as SolverResult);
    expect(feedback).toMatch(/gt10/);
    expect(feedback).toMatch(/lt5/);
    expect(feedback).toMatch(/conflict/i);
  });

  it("classifies unsat result without core", () => {
    const result: SolverResult = { status: "unsat" as const };
    const feedback = classifyFeedback(result);
    expect(feedback).toMatch(/contradictory|over-constrained/i);
  });

  it("classifies sat result with model", () => {
    const result: SolverResult = { status: "sat", model: { x: "5", y: "3" } };
    const feedback = classifyFeedback(result);
    expect(feedback).toContain("5");
    expect(feedback).toContain("3");
  });

  it("classifies prolog success with no answers", () => {
    const result: SolverResult = { status: "success", answers: [] };
    const feedback = classifyFeedback(result);
    expect(feedback).toMatch(/no.*solution|no.*answer/i);
  });

  it("classifies prolog success with answers", () => {
    const result: SolverResult = {
      status: "success",
      answers: [{ bindings: { X: "bob" }, formatted: "X = bob" }],
    };
    const feedback = classifyFeedback(result);
    expect(feedback).toContain("1");
    expect(feedback).toContain("X = bob");
  });

  it("classifies unknown result", () => {
    const result: SolverResult = { status: "unknown" };
    const feedback = classifyFeedback(result);
    expect(feedback).toMatch(/unknown/i);
  });
});
