import { describe, it, expect } from "vitest";
import { parseMermaid } from "../../src/graph/mermaid.js";
import { createPrologSolver } from "../../src/solvers/prolog-solver.js";

describe("parseMermaid", () => {
  describe("flowchart", () => {
    it("parses simple edge A --> B", () => {
      const prolog = parseMermaid("graph TD\n  A --> B");
      expect(prolog).toContain("edge(a, b).");
    });

    it("parses nodes with labels", () => {
      const prolog = parseMermaid("graph TD\n  A[User Input] --> B[Database]");
      expect(prolog).toContain("node(a, 'User Input').");
      expect(prolog).toContain("node(b, 'Database').");
      expect(prolog).toContain("edge(a, b).");
    });

    it("parses labeled edges", () => {
      const prolog = parseMermaid("graph TD\n  A -->|Yes| B\n  A -->|No| C");
      expect(prolog).toContain("edge(a, b).");
      expect(prolog).toContain("edge(a, c).");
      expect(prolog).toContain("edge_label(a, b, 'Yes').");
      expect(prolog).toContain("edge_label(a, c, 'No').");
    });

    it("parses multiple edges", () => {
      const prolog = parseMermaid(`
graph TD
    A --> B
    B --> C
    C --> D
    A --> D
      `);
      expect(prolog).toContain("edge(a, b).");
      expect(prolog).toContain("edge(b, c).");
      expect(prolog).toContain("edge(c, d).");
      expect(prolog).toContain("edge(a, d).");
    });

    it("normalizes IDs to lowercase", () => {
      const prolog = parseMermaid("graph TD\n  UserInput --> DbQuery");
      expect(prolog).toContain("edge(userinput, dbquery).");
    });

    it("ignores comments and empty lines", () => {
      const prolog = parseMermaid(`
graph TD
    %% This is a comment
    A --> B

    B --> C
      `);
      expect(prolog).toContain("edge(a, b).");
      expect(prolog).toContain("edge(b, c).");
      expect(prolog).not.toContain("comment");
    });

    it("includes reachability rules", () => {
      const prolog = parseMermaid("graph TD\n  A --> B");
      expect(prolog).toContain("reaches(");
      expect(prolog).toContain("member(");
    });

    it("handles flowchart keyword", () => {
      const prolog = parseMermaid("flowchart LR\n  A --> B");
      expect(prolog).toContain("edge(a, b).");
    });

    it("handles different arrow styles", () => {
      const prolog = parseMermaid(`
graph TD
    A --> B
    B --- C
    C -.-> D
    D ==> E
      `);
      expect(prolog).toContain("edge(a, b).");
      expect(prolog).toContain("edge(b, c).");
      expect(prolog).toContain("edge(c, d).");
      expect(prolog).toContain("edge(d, e).");
    });
  });

  describe("stateDiagram", () => {
    it("parses state transitions", () => {
      const prolog = parseMermaid(`
stateDiagram-v2
    Active --> Paused : pause
    Paused --> Active : resume
      `);
      expect(prolog).toContain("transition(active, paused, pause).");
      expect(prolog).toContain("transition(paused, active, resume).");
    });

    it("handles [*] start/end markers", () => {
      const prolog = parseMermaid(`
stateDiagram-v2
    [*] --> Active
    Active --> [*] : finish
      `);
      expect(prolog).toContain("transition(start_end, active,");
      expect(prolog).toContain("transition(active, start_end, finish).");
    });

    it("handles transitions without events", () => {
      const prolog = parseMermaid(`
stateDiagram-v2
    Idle --> Running
      `);
      expect(prolog).toContain("transition(idle, running, auto).");
    });

    it("includes can_reach rules", () => {
      const prolog = parseMermaid(`
stateDiagram-v2
    A --> B
      `);
      expect(prolog).toContain("can_reach(");
    });
  });

  describe("solver integration", () => {
    it("flowchart output is valid Prolog", async () => {
      const prolog = parseMermaid(`
graph TD
    A[Start] --> B[Middle]
    B --> C[End]
      `);
      const solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: prolog,
        query: "edge(a, b).",
      });
      solver.dispose();
      expect(result.status).toBe("success");
    });

    it("reachability works on flowchart", async () => {
      const prolog = parseMermaid(`
graph TD
    A --> B
    B --> C
    C --> D
      `);
      const solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: prolog,
        query: "reaches(a, d).",
      });
      solver.dispose();
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.length).toBeGreaterThan(0);
      }
    });

    it("state diagram output is valid Prolog", async () => {
      const prolog = parseMermaid(`
stateDiagram-v2
    Idle --> Active : start
    Active --> Done : finish
      `);
      const solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program: prolog,
        query: "can_reach(idle, done).",
      });
      solver.dispose();
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.length).toBeGreaterThan(0);
      }
    });
  });
});
