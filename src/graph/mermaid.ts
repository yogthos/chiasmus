import { escapeAtom, MEMBER_RULES } from "./facts.js";

type DiagramType = "flowchart" | "stateDiagram";

interface MermaidNode {
  id: string;
  label?: string;
}

interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

interface MermaidGraph {
  type: DiagramType;
  nodes: Map<string, MermaidNode>;
  edges: MermaidEdge[];
}

const FLOWCHART_RULES = `
${MEMBER_RULES}
reaches(A, B) :- reaches(A, B, [A]).
reaches(A, B, _) :- edge(A, B).
reaches(A, B, Visited) :- edge(A, Mid), \\+ member(Mid, Visited), reaches(Mid, B, [Mid|Visited]).
`.trim();

const STATE_RULES = `
${MEMBER_RULES}
can_reach(A, B) :- can_reach(A, B, [A]).
can_reach(A, B, _) :- transition(A, B, _).
can_reach(A, B, Visited) :- transition(A, Mid, _), \\+ member(Mid, Visited), can_reach(Mid, B, [Mid|Visited]).
`.trim();

/** Normalize a mermaid node ID to a valid Prolog atom */
function normalizeId(id: string): string {
  // Handle special state diagram markers
  if (id === "[*]") return "start_end";

  return id
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    || "node";
}

/** Parse a mermaid diagram and return a Prolog program */
export function parseMermaid(input: string): string {
  const graph = extractMermaidGraph(input);
  return generateProlog(graph);
}

function extractMermaidGraph(input: string): MermaidGraph {
  const lines = input.split("\n").map((l) => l.trim());
  const type = detectDiagramType(lines);
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  for (const line of lines) {
    // Skip header, comments, empty lines, subgraph/end keywords
    if (!line || line.startsWith("%%") || /^(graph|flowchart|stateDiagram)\b/i.test(line)
      || line === "end" || /^subgraph\b/i.test(line)) {
      continue;
    }

    if (type === "stateDiagram") {
      parseStateLine(line, nodes, edges);
    } else {
      parseFlowchartLine(line, nodes, edges);
    }
  }

  return { type, nodes, edges };
}

function detectDiagramType(lines: string[]): DiagramType {
  for (const line of lines) {
    if (/^stateDiagram/i.test(line)) return "stateDiagram";
    if (/^(graph|flowchart)\b/i.test(line)) return "flowchart";
  }
  return "flowchart"; // default
}

function parseFlowchartLine(
  line: string,
  nodes: Map<string, MermaidNode>,
  edges: MermaidEdge[],
): void {
  // Try to match edge pattern
  // More permissive: extract source, arrow+label, target
  const parts = line.match(
    /^([A-Za-z0-9_]+)(\s*[\[({].*?[\])}])?\s*([-=][-=.]+[>ox]?)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)(\s*[\[({].*?[\])}])?\s*;?\s*$/,
  );
  if (!parts) return;

  const [, srcId, srcLabel, , edgeLabel, tgtId, tgtLabel] = parts;

  const srcNorm = normalizeId(srcId);
  const tgtNorm = normalizeId(tgtId);

  // Register nodes
  if (!nodes.has(srcNorm)) {
    nodes.set(srcNorm, { id: srcNorm, label: extractLabel(srcLabel) });
  } else if (extractLabel(srcLabel) && !nodes.get(srcNorm)!.label) {
    nodes.get(srcNorm)!.label = extractLabel(srcLabel);
  }

  if (!nodes.has(tgtNorm)) {
    nodes.set(tgtNorm, { id: tgtNorm, label: extractLabel(tgtLabel) });
  } else if (extractLabel(tgtLabel) && !nodes.get(tgtNorm)!.label) {
    nodes.get(tgtNorm)!.label = extractLabel(tgtLabel);
  }

  edges.push({ from: srcNorm, to: tgtNorm, label: edgeLabel?.trim() });
}

function parseStateLine(
  line: string,
  nodes: Map<string, MermaidNode>,
  edges: MermaidEdge[],
): void {
  // State transitions: StateA --> StateB : event
  // Handle [*] as a special node marker
  const parts = line.match(
    /^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)\s*(?::\s*(.+))?$/,
  );
  if (!parts) return;

  const [, srcRaw, tgtRaw, event] = parts;
  const srcNorm = normalizeId(srcRaw);
  const tgtNorm = normalizeId(tgtRaw);

  if (!nodes.has(srcNorm)) nodes.set(srcNorm, { id: srcNorm });
  if (!nodes.has(tgtNorm)) nodes.set(tgtNorm, { id: tgtNorm });

  edges.push({ from: srcNorm, to: tgtNorm, label: event?.trim() });
}

function extractLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Strip brackets/parens: [Label], (Label), {Label}, ((Label)), etc.
  const match = raw.trim().match(/^[\[({]+\s*(.*?)\s*[\])}]+$/);
  return match?.[1] || undefined;
}

function generateProlog(graph: MermaidGraph): string {
  const lines: string[] = [];

  if (graph.type === "stateDiagram") {
    // State diagram: transition(From, To, Event).
    lines.push(":- dynamic(transition/3).");
    lines.push(":- dynamic(state/1).");
    lines.push("");

    for (const node of graph.nodes.values()) {
      lines.push(`state(${escapeAtom(node.id)}).`);
    }
    if (graph.nodes.size > 0) lines.push("");

    for (const edge of graph.edges) {
      const event = edge.label || "auto";
      lines.push(`transition(${escapeAtom(edge.from)}, ${escapeAtom(edge.to)}, ${escapeAtom(event)}).`);
    }
    lines.push("");
    lines.push(STATE_RULES);
  } else {
    // Flowchart: node(Id, Label). edge(From, To).
    lines.push(":- dynamic(node/2).");
    lines.push(":- dynamic(edge/2).");
    lines.push(":- dynamic(edge_label/3).");
    lines.push("");

    for (const node of graph.nodes.values()) {
      if (node.label) {
        lines.push(`node(${escapeAtom(node.id)}, ${escapeAtom(node.label)}).`);
      } else {
        lines.push(`node(${escapeAtom(node.id)}, ${escapeAtom(node.id)}).`);
      }
    }
    if (graph.nodes.size > 0) lines.push("");

    for (const edge of graph.edges) {
      lines.push(`edge(${escapeAtom(edge.from)}, ${escapeAtom(edge.to)}).`);
    }

    const labeledEdges = graph.edges.filter((e) => e.label);
    if (labeledEdges.length > 0) {
      lines.push("");
      for (const edge of labeledEdges) {
        lines.push(`edge_label(${escapeAtom(edge.from)}, ${escapeAtom(edge.to)}, ${escapeAtom(edge.label!)}).`);
      }
    }
    lines.push("");
    lines.push(FLOWCHART_RULES);
  }

  return lines.join("\n");
}
