interface TaintResult {
  reachable: Array<{ source: string; sink: string }>;
  unreachable: string[];
}

export async function solveTraditional(input: {
  edges: Array<{ from: string; to: string }>;
  sources: string[];
  sinks: string[];
}): Promise<TaintResult> {
  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from)!.push(edge.to);
  }

  // BFS from each source to find all reachable nodes
  function reachableFrom(start: string): Set<string> {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of adj.get(node) ?? []) {
        queue.push(next);
      }
    }
    return visited;
  }

  const reachable: Array<{ source: string; sink: string }> = [];
  const unreachable: string[] = [];

  for (const source of input.sources) {
    const reached = reachableFrom(source);
    for (const sink of input.sinks) {
      if (reached.has(sink)) {
        reachable.push({ source, sink });
      } else {
        unreachable.push(sink);
      }
    }
  }

  return { reachable, unreachable };
}
