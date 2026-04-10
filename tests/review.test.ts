import { describe, it, expect } from "vitest";
import { buildReviewPlan } from "../src/review.js";

describe("buildReviewPlan", () => {
  const files = ["/abs/src/handler.ts", "/abs/src/db.ts"];

  it("returns a plan with files echoed back", () => {
    const plan = buildReviewPlan({ files });
    expect(plan.files).toEqual(files);
    expect(plan.focus).toBe("all");
  });

  it("defaults focus to 'all' when omitted", () => {
    const plan = buildReviewPlan({ files });
    expect(plan.focus).toBe("all");
  });

  it("returns phases as a non-empty array", () => {
    const plan = buildReviewPlan({ files });
    expect(Array.isArray(plan.phases)).toBe(true);
    expect(plan.phases.length).toBeGreaterThan(0);
    for (const phase of plan.phases) {
      expect(phase.phase).toBeTruthy();
      expect(phase.goal).toBeTruthy();
      expect(Array.isArray(phase.actions)).toBe(true);
    }
  });

  it("phase actions reference real chiasmus tools", () => {
    const plan = buildReviewPlan({ files });
    const validTools = new Set([
      "chiasmus_graph",
      "chiasmus_formalize",
      "chiasmus_verify",
      "chiasmus_skills",
      "chiasmus_lint",
    ]);
    for (const phase of plan.phases) {
      for (const action of phase.actions) {
        expect(validTools.has(action.tool)).toBe(true);
        expect(action.args).toBeTypeOf("object");
        expect(action.interpret).toBeTruthy();
      }
    }
  });

  it("'all' focus includes structural, architecture, security, correctness phases", () => {
    const plan = buildReviewPlan({ files, focus: "all" });
    const phaseNames = plan.phases.map((p) => p.phase.toLowerCase());
    expect(phaseNames.some((n) => n.includes("structural") || n.includes("overview"))).toBe(true);
    expect(phaseNames.some((n) => n.includes("architecture") || n.includes("dead") || n.includes("layer"))).toBe(true);
    expect(phaseNames.some((n) => n.includes("security") || n.includes("taint") || n.includes("data flow"))).toBe(true);
    expect(phaseNames.some((n) => n.includes("correctness") || n.includes("invariant") || n.includes("bug"))).toBe(true);
  });

  it("'quick' focus is a strict subset of 'all' (fewer phases)", () => {
    const all = buildReviewPlan({ files, focus: "all" });
    const quick = buildReviewPlan({ files, focus: "quick" });
    expect(quick.phases.length).toBeLessThan(all.phases.length);
    expect(quick.phases.length).toBeGreaterThan(0);
  });

  it("'security' focus includes taint-propagation via chiasmus_formalize", () => {
    const plan = buildReviewPlan({ files, focus: "security" });
    const hasFormalize = plan.phases.some((p) =>
      p.actions.some((a) => a.tool === "chiasmus_formalize"),
    );
    expect(hasFormalize).toBe(true);
    // Security focus should explicitly mention taint-propagation in some action
    const mentionsTaint = plan.phases.some((p) =>
      p.actions.some(
        (a) =>
          JSON.stringify(a).toLowerCase().includes("taint") ||
          a.interpret.toLowerCase().includes("taint"),
      ),
    );
    expect(mentionsTaint).toBe(true);
  });

  it("'architecture' focus includes dead-code, cycles, and layer-violation analyses", () => {
    const plan = buildReviewPlan({ files, focus: "architecture" });
    const analyses = new Set<string>();
    for (const phase of plan.phases) {
      for (const action of phase.actions) {
        if (action.tool === "chiasmus_graph") {
          const analysis = (action.args as { analysis?: string }).analysis;
          if (analysis) analyses.add(analysis);
        }
      }
    }
    expect(analyses.has("dead-code")).toBe(true);
    expect(analyses.has("cycles")).toBe(true);
    expect(analyses.has("layer-violation")).toBe(true);
  });

  it("'correctness' focus suggests invariant-check or boundary-condition templates", () => {
    const plan = buildReviewPlan({ files, focus: "correctness" });
    const suggested = plan.suggestedTemplates.map((t) => t.template);
    expect(
      suggested.includes("invariant-check") ||
        suggested.includes("boundary-condition") ||
        suggested.includes("state-machine-deadlock"),
    ).toBe(true);
  });

  it("graph actions pass through the files array", () => {
    const plan = buildReviewPlan({ files });
    for (const phase of plan.phases) {
      for (const action of phase.actions) {
        if (action.tool === "chiasmus_graph") {
          expect((action.args as { files: string[] }).files).toEqual(files);
        }
      }
    }
  });

  it("includes entry_points in graph actions when provided", () => {
    const plan = buildReviewPlan({
      files,
      entry_points: ["handleRequest", "main"],
    });
    const deadCodeAction = plan.phases
      .flatMap((p) => p.actions)
      .find(
        (a) =>
          a.tool === "chiasmus_graph" &&
          (a.args as { analysis?: string }).analysis === "dead-code",
      );
    expect(deadCodeAction).toBeDefined();
    expect(
      (deadCodeAction!.args as { entry_points?: string[] }).entry_points,
    ).toEqual(["handleRequest", "main"]);
  });

  it("includes a reporting section describing severity format", () => {
    const plan = buildReviewPlan({ files });
    expect(plan.reporting).toBeDefined();
    expect(plan.reporting.format).toBeTruthy();
    expect(Array.isArray(plan.reporting.severityLevels)).toBe(true);
    expect(plan.reporting.severityLevels.length).toBeGreaterThan(0);
  });

  it("includes a suggestedTemplates section listing named templates with workflow hints", () => {
    const plan = buildReviewPlan({ files });
    expect(Array.isArray(plan.suggestedTemplates)).toBe(true);
    expect(plan.suggestedTemplates.length).toBeGreaterThan(0);
    for (const t of plan.suggestedTemplates) {
      expect(t.template).toBeTruthy();
      expect(t.when).toBeTruthy();
      expect(t.workflow).toBeTruthy();
    }
  });

  it("rejects empty files array", () => {
    expect(() => buildReviewPlan({ files: [] })).toThrow(/files/i);
  });

  it("rejects unknown focus value", () => {
    // deliberately cast to exercise runtime guard
    expect(() =>
      buildReviewPlan({ files, focus: "nonsense" as unknown as "all" }),
    ).toThrow(/focus/i);
  });
});
