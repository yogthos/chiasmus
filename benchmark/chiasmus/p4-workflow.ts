import { createPrologSolver } from "../../src/solvers/prolog-solver.js";

interface WorkflowResult {
  unreachableStates: string[];
  deadEndStates: string[];
}

export async function solveChiasmus(input: {
  initial: string;
  states: string[];
  transitions: Array<{ from: string; to: string; action: string }>;
}): Promise<WorkflowResult> {
  const solver = createPrologSolver();

  const transitionFacts = input.transitions
    .map((t) => `transition(${t.from}, ${t.to}).`)
    .join("\n");

  const program = `
${transitionFacts}
has_outgoing(X) :- transition(X, _).
`;

  try {
    // BFS reachability using Prolog for edge queries
    const reachable = new Set<string>([input.initial]);
    const frontier = [input.initial];

    while (frontier.length > 0) {
      const current = frontier.pop()!;
      const result = await solver.solve({
        type: "prolog",
        program,
        query: `transition(${current}, X).`,
      });

      if (result.status === "success") {
        for (const ans of result.answers) {
          const next = ans.bindings.X;
          if (!reachable.has(next)) {
            reachable.add(next);
            frontier.push(next);
          }
        }
      }
    }

    // Check which states have outgoing transitions
    const hasOutgoing = new Set<string>();
    const outResult = await solver.solve({
      type: "prolog",
      program,
      query: "has_outgoing(X).",
    });
    if (outResult.status === "success") {
      for (const ans of outResult.answers) {
        hasOutgoing.add(ans.bindings.X);
      }
    }

    const unreachableStates = input.states.filter((s) => !reachable.has(s));
    const deadEndStates = input.states.filter(
      (s) => reachable.has(s) && !hasOutgoing.has(s) && s !== input.initial
    );

    return { unreachableStates, deadEndStates };
  } finally {
    solver.dispose();
  }
}
