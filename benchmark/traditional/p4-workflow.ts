interface WorkflowResult {
  unreachableStates: string[];
  deadEndStates: string[];
}

export async function solveTraditional(input: {
  initial: string;
  states: string[];
  transitions: Array<{ from: string; to: string; action: string }>;
}): Promise<WorkflowResult> {
  // BFS from initial state
  const adj = new Map<string, string[]>();
  const hasOutgoing = new Set<string>();

  for (const t of input.transitions) {
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from)!.push(t.to);
    hasOutgoing.add(t.from);
  }

  const reachable = new Set<string>();
  const queue = [input.initial];
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (reachable.has(state)) continue;
    reachable.add(state);
    for (const next of adj.get(state) ?? []) {
      queue.push(next);
    }
  }

  const unreachableStates = input.states.filter((s) => !reachable.has(s));
  const deadEndStates = input.states.filter(
    (s) => reachable.has(s) && !hasOutgoing.has(s) && s !== input.initial
  );

  return { unreachableStates, deadEndStates };
}
