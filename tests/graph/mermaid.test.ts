import { describe, it, expect } from "vitest";
import { STATE_TRANSITION, matchFlowchartEdge, parseMermaid } from "../../src/graph/mermaid.js";
import { escapeAtom } from "../../src/graph/facts.js";
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
      expect(prolog).toContain("chiasmus_member(");
      expect(prolog).not.toMatch(/^member\(/m);
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

    it("parses chained edges A --> B --> C", () => {
      const prolog = parseMermaid("graph TD\n  A[Start] --> B -->|ok| C[End];");
      expect(prolog).toContain("node(a, 'Start').");
      expect(prolog).toContain("node(c, 'End').");
      expect(prolog).toContain("edge(a, b).");
      expect(prolog).toContain("edge(b, c).");
      expect(prolog).toContain("edge_label(b, c, ok).");
    });

    it("parses text between the dashes as the edge label", () => {
      const prolog = parseMermaid(`
graph TD
    A -- approve --> B
    B == two words ==> C
    C -. maybe .-> D
      `);
      expect(prolog).toContain("edge_label(a, b, approve).");
      expect(prolog).toContain("edge_label(b, c, 'two words').");
      expect(prolog).toContain("edge_label(c, d, maybe).");
    });

    it("links every node of an & group", () => {
      const prolog = parseMermaid("graph TD\n  A & B --> C & D[Done]");
      for (const edge of ["edge(a, c).", "edge(a, d).", "edge(b, c).", "edge(b, d)."]) {
        expect(prolog).toContain(edge);
      }
      expect(prolog).toContain("node(d, 'Done').");
    });

    it("mixes chains, edge text and & groups on one line", () => {
      const prolog = parseMermaid("graph TD\n  A -- go --> B & C --> D");
      expect(prolog).toContain("edge_label(a, b, go).");
      expect(prolog).toContain("edge_label(a, c, go).");
      expect(prolog).toContain("edge(b, d).");
      expect(prolog).toContain("edge(c, d).");
    });

    it("still skips lines that aren't edges", () => {
      const prolog = parseMermaid("graph TD\n  A --> B -->\n  C -- text --> \n  D &\n  E[x --> F");
      expect(prolog.match(/^edge\(/gm)).toBeNull();
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

    it.each([
      ["a chain", "A --> B --> C", "reaches(a, c)."],
      ["edge text", "A -- approve --> B\n    B --> C", "reaches(a, c)."],
      ["an & group", "A --> B & C\n    C --> D", "reaches(a, d)."],
    ])("reachability follows %s", async (_form, body, query) => {
      const solver = createPrologSolver();
      const result = await solver.solve({ type: "prolog", program: parseMermaid(`graph TD\n    ${body}`), query });
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

  // chiasmus_verify parses Mermaid in the server process, before any solver,
  // so a slow parse stalls every session (and a long enough one gets the
  // daemon restarted by its health watchdog). The edge pattern used to
  // backtrack: it tried every split of a run of spaces between its adjacent
  // `\s*`s (a 128 KB line took 7.7 s, growing about cubically), and every `]`
  // as the end of a source label, rescanning the rest of the line for each
  // (80 KB took over a second, growing quadratically).
  describe("input size", () => {
    const SPACES = 100_000;
    it.each([
      ["spaces after the arrow", `A -->${" ".repeat(SPACES)}!`],
      ["spaces between the source and the arrow", `A${" ".repeat(SPACES)}!`],
      ["spaces after the target", `A --> B${" ".repeat(SPACES)}!`],
      ["spaces after an edge label", `A -->|x|${" ".repeat(SPACES)}!`],
      ["label ends that each start an edge", `A[${"] --> B[ ".repeat(SPACES / 5)}!`],
      ["label ends that each start an edge, unspaced", `A[${"]-->B[".repeat(SPACES / 5)}!`],
      ["label ends inside edge labels", `A[${"]-->|]-->B| B".repeat(SPACES / 10)}!`],
      ["spaces in a state transition", `[*]${" ".repeat(SPACES)}-->${" ".repeat(SPACES)}!`],
      ["spaces before a broken state event", `[*] --> B :${" ".repeat(SPACES)}\rx\ry`],
      ["spaces inside a node label", `A[x${" ".repeat(SPACES)}x] --> B`],
      ["spaces inside a target label", `A --> B(x${" ".repeat(SPACES)}x)`],
      ["a long chain", `A${" --> A".repeat(SPACES / 6)} !`],
      ["spaces in edge text", `A --${" ".repeat(SPACES)}x`],
      ["edge text that never closes", `A -- x${" -- x".repeat(SPACES / 5)}`],
      ["a long & group", `A -->${" B &".repeat(SPACES / 4)} !`],
    ])("parses a line with %s in linear time", (_where, line) => {
      const header = line.startsWith("[*]") ? "stateDiagram-v2" : "flowchart TD";
      const started = performance.now();
      parseMermaid(`${header}\n${line}`);
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("refuses an & link that would expand past the edge limit", () => {
      const group = (name: string, size: number) => Array.from({ length: size }, (_, k) => `${name}${k}`).join(" & ");
      expect(() => parseMermaid(`flowchart TD\n${group("a", 101)} --> ${group("b", 101)}`)).toThrow(/exceeds 10000 edges/);
      expect(parseMermaid(`flowchart TD\n${group("a", 100)} --> ${group("b", 100)}`)).toContain("edge(a99, b99).");
    });

    // The pattern as it was: the scanner must accept exactly the same lines
    // and capture the same parts.
    const LEGACY_FLOWCHART_EDGE =
      /^([A-Za-z0-9_]+)(\s*[\[({].*?[\])}])?\s*([-=][-=.]+[>ox]?)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)(\s*[\[({].*?[\])}])?\s*;?\s*$/;

    const same = (line: string) => {
      const before = LEGACY_FLOWCHART_EDGE.exec(line);
      expect(matchFlowchartEdge(line), JSON.stringify(line)).toEqual(before ? [...before] : null);
      return before !== null;
    };

    it("matches flowchart edges exactly as the old pattern did", () => {
      const tokens = [
        "A", "b_1", "C2", "o", "x", " ", "  ", "\t", "\r", "\u00a0", "\u2028", "\u3000", "\u200b", "\u180e",
        "-->", "---", "==>", "-.->", "--o", "--x", "-", "=", ".", ">", "|", "|yes|", "||",
        "[", "]", "(", ")", "{", "}", "[Label]", "(x)", "{y}", "((r))", "[a]]", ";", ";;", "!", ":",
      ];
      let seed = 42;
      const next = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      let matched = 0;
      for (let i = 0; i < 20_000; i++) {
        let line = "";
        const length = 1 + next(12);
        for (let t = 0; t < length; t++) line += tokens[next(tokens.length)];
        // Lines often take the shape of an edge, so both branches get exercised.
        if (next(2) === 0) line = `${tokens[next(3)]}${line.includes("-") ? "" : " --> "}${line}`;
        if (same(line)) matched++;
      }
      expect(matched).toBeGreaterThan(1_000);
    });

    // A node label's text comes from this pattern, run on each label the edge
    // scanner accepts: its lazy middle and the \s* after it rescanned a run of
    // spaces once per character (131,072 spaces took 13.9 s).
    const LEGACY_LABEL = /^[\[({]+\s*(.*?)\s*[\])}]+$/;
    const sameLabel = (raw: string) => {
      const before = raw.trim().match(LEGACY_LABEL)?.[1] || undefined;
      const prolog = parseMermaid(`graph TD\nA${raw} --> B`);
      if (!matchFlowchartEdge(`A${raw} --> B`)) return;
      const label = /^node\(a, (.*)\)\.$/m.exec(prolog)?.[1];
      expect(label, JSON.stringify(raw)).toBe(before === undefined ? "a" : escapeAtom(before));
    };

    it("takes node labels' text exactly as the old pattern did", () => {
      const tokens = ["[", "]", "(", ")", "{", "}", " ", "\t", "\r", "\u2028", "\u00a0", "x", "y z", "'", "-->", "|"];
      let seed = 7;
      const next = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      for (let i = 0; i < 20_000; i++) {
        let raw = "[(".charAt(next(2));
        const length = next(8);
        for (let t = 0; t < length; t++) raw += tokens[next(tokens.length)];
        sameLabel(raw + "])".charAt(next(2)));
      }
      for (let code = 0; code <= 0xffff; code++) {
        const c = String.fromCharCode(code);
        for (const raw of [`[${c}]`, `[x${c}]`, `[${c}x]`, `[x${c}x]`]) sameLabel(raw);
      }
    });

    // The state transition pattern as it was.
    const LEGACY_STATE = /^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)\s*(?::\s*(.+))?$/;

    it("matches state transitions exactly as the old pattern did", () => {
      const tokens = ["A", "b", "[*]", "-->", "->", " ", "  ", "\t", "\r", "\u2028", "\u00a0", ":", "go", "x y", "!"];
      let seed = 11;
      const next = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      let matched = 0;
      for (let i = 0; i < 20_000; i++) {
        let line = next(2) === 0 ? "A --> B " : "";
        const length = 1 + next(8);
        for (let t = 0; t < length; t++) line += tokens[next(tokens.length)];
        for (const l of [line, line.trim()]) {
          const before = LEGACY_STATE.exec(l);
          expect(STATE_TRANSITION.exec(l)?.slice() ?? null, JSON.stringify(l)).toEqual(before?.slice() ?? null);
          if (before) matched++;
        }
      }
      expect(matched).toBeGreaterThan(1_000);
    });

    it("treats exactly the characters \\s matches as whitespace", () => {
      for (let code = 0; code <= 0xffff; code++) {
        const c = String.fromCharCode(code);
        for (const line of [`A${c}-->B`, `A -->${c}B`, `A --> B${c}`, `A --> B[x${c}y]`, `A[${c}] --> B`]) same(line);
      }
    });
  });
});
