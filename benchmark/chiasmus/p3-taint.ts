import { createPrologSolver } from "../../src/solvers/prolog-solver.js";

interface TaintResult {
  reachable: Array<{ source: string; sink: string }>;
  unreachable: string[];
}

export async function solveChiasmus(input: {
  edges: Array<{ from: string; to: string }>;
  sources: string[];
  sinks: string[];
}): Promise<TaintResult> {
  const solver = createPrologSolver();

  const edgeFacts = input.edges
    .map((e) => `edge(${e.from}, ${e.to}).`)
    .join("\n");

  const program = `
${edgeFacts}
reaches(A, B) :- edge(A, B).
reaches(A, B) :- edge(A, Mid), reaches(Mid, B).
`;

  const reachable: Array<{ source: string; sink: string }> = [];
  const unreachable: string[] = [];

  try {
    for (const source of input.sources) {
      for (const sink of input.sinks) {
        const result = await solver.solve({
          type: "prolog",
          program,
          query: `reaches(${source}, ${sink}).`,
        });

        if (result.status === "success" && result.answers.length > 0) {
          reachable.push({ source, sink });
        } else {
          unreachable.push(sink);
        }
      }
    }
  } finally {
    solver.dispose();
  }

  return { reachable, unreachable };
}
