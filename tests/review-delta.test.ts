import { describe, it, expect } from "vitest";
import { buildReviewPlan } from "../src/review.js";

describe("buildReviewPlan: PR-delta integration", () => {
  it("inserts a delta phase as phase 0 when delta_against is supplied", () => {
    const plan = buildReviewPlan({
      files: ["/abs/a.ts"],
      focus: "all",
      delta_against: "main",
    });
    expect(plan.phases[0].phase.toLowerCase()).toMatch(/delta|pr/);
    expect(plan.phases[0].actions.some((a) => a.tool === "chiasmus_graph" && (a.args as any).analysis === "diff")).toBe(true);
  });

  it("delta phase is absent when delta_against is omitted", () => {
    const plan = buildReviewPlan({ files: ["/abs/a.ts"], focus: "all" });
    for (const p of plan.phases) {
      for (const a of p.actions) {
        if (a.tool === "chiasmus_graph") {
          expect((a.args as any).analysis).not.toBe("diff");
        }
      }
    }
  });

  it("delta phase passes the against + save_snapshot args through", () => {
    const plan = buildReviewPlan({
      files: ["/abs/a.ts"],
      focus: "all",
      delta_against: "main",
    });
    const diffAction = plan.phases[0].actions.find((a) => a.tool === "chiasmus_graph" && (a.args as any).analysis === "diff");
    expect(diffAction).toBeDefined();
    expect((diffAction!.args as any).against).toBe("main");
    // The phase must also mention caching/snapshotting in interpret so the
    // caller knows diff requires persisted state.
    expect(diffAction!.interpret).toMatch(/snapshot|cache/i);
  });

  it("delta phase still fires under focus='quick' (PR review is always useful)", () => {
    const plan = buildReviewPlan({
      files: ["/abs/a.ts"],
      focus: "quick",
      delta_against: "main",
    });
    expect(plan.phases[0].phase.toLowerCase()).toMatch(/delta|pr/);
  });

  it("reporting section mentions PR scope when delta_against is set", () => {
    const plan = buildReviewPlan({
      files: ["/abs/a.ts"],
      focus: "all",
      delta_against: "main",
    });
    expect(plan.reporting.instructions.toLowerCase()).toMatch(/pr|change|delta/);
  });
});
