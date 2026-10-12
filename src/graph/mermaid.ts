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
reaches(A, B, Visited) :- edge(A, Mid), \\+ chiasmus_member(Mid, Visited), reaches(Mid, B, [Mid|Visited]).
`.trim();

const STATE_RULES = `
${MEMBER_RULES}
can_reach(A, B) :- can_reach(A, B, [A]).
can_reach(A, B, _) :- transition(A, B, _).
can_reach(A, B, Visited) :- transition(A, Mid, _), \\+ chiasmus_member(Mid, Visited), can_reach(Mid, B, [Mid|Visited]).
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

/** [line, source, source label, arrow, edge label, target, target label] */
type EdgeMatch = [string, string, string | undefined, string, string | undefined, string, string | undefined];

// What JavaScript's \s matches: WhiteSpace and LineTerminator (ECMA-262),
// with the Unicode Zs category as of Unicode 15.
function isWs(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** What `.` does not match. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

function isIdChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

const isOpen = (c: string) => c === "[" || c === "(" || c === "{";
const isClose = (c: string) => c === "]" || c === ")" || c === "}";

/**
 * Matches a flowchart edge line the way this pattern did, captures included:
 *
 *   ^([A-Za-z0-9_]+)(\s*[\[({].*?[\])}])?\s*([-=][-=.]+[>ox]?)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)(\s*[\[({].*?[\])}])?\s*;?\s*$
 *
 * (source, source label, arrow, edge label, target, target label), in time
 * linear in the line. The pattern backtracked: its adjacent `\s*`s tried
 * every split of a run of spaces, and the lazy source label tried every
 * closing bracket as its end, rescanning the rest of the line for each. A few
 * hundred KB held the server's event loop for minutes. Here the line's tail
 * (spaces, an optional `;`, spaces) is found once from the right, which fixes
 * where a target label must end, so each candidate end of the source label is
 * checked in time proportional to the text up to its target. Returns what
 * RegExp.exec would, as a plain array. Exported for tests.
 */
export function matchFlowchartEdge(line: string): EdgeMatch | null {
  const n = line.length;
  const skipWs = (i: number) => {
    while (i < n && isWs(line.charCodeAt(i))) i++;
    return i;
  };
  const skipId = (i: number) => {
    while (i < n && isIdChar(line.charCodeAt(i))) i++;
    return i;
  };

  // The tail: the shortest suffix of spaces, an optional `;`, then spaces.
  let tail = n;
  while (tail > 0 && isWs(line.charCodeAt(tail - 1))) tail--;
  if (tail > 0 && line[tail - 1] === ";") {
    tail--;
    while (tail > 0 && isWs(line.charCodeAt(tail - 1))) tail--;
  }
  // A target label can only end just before the tail, and can't span a line
  // terminator.
  let lastTerminator = -1;
  for (let i = 0; i < tail - 1; i++) if (isLineTerminator(line.charCodeAt(i))) lastTerminator = i;

  // Everything after the source (and its label): arrow, edge label, target, target label, tail.
  const afterSource = (from: number): [string, string | undefined, string, string | undefined] | null => {
    const a = skipWs(from);
    if (line[a] !== "-" && line[a] !== "=") return null;
    let k = a + 1;
    while (k < n && (line[k] === "-" || line[k] === "=" || line[k] === ".")) k++;
    if (k === a + 1) return null;
    // `[>ox]?` takes its character if it can; `o` and `x` can also start the target.
    const ends = k < n && (line[k] === ">" || line[k] === "o" || line[k] === "x") ? [k + 1, k] : [k];
    for (const arrowEnd of ends) {
      const b = skipWs(arrowEnd);
      let edgeLabel: string | undefined;
      let targetStart = b;
      if (line[b] === "|") {
        const close = line.indexOf("|", b + 1);
        if (close === -1) continue;
        edgeLabel = line.slice(b + 1, close);
        targetStart = skipWs(close + 1);
      }
      const targetEnd = skipId(targetStart);
      if (targetEnd === targetStart) continue;
      const labelStart = skipWs(targetEnd);
      let targetLabel: string | undefined;
      if (
        labelStart < tail - 1 && isOpen(line[labelStart]) && isClose(line[tail - 1])
        && lastTerminator < labelStart
      ) {
        targetLabel = line.slice(targetEnd, tail);
      } else if (targetEnd < tail) {
        continue;
      }
      return [line.slice(a, arrowEnd), edgeLabel, line.slice(targetStart, targetEnd), targetLabel];
    }
    return null;
  };

  const sourceEnd = skipId(0);
  if (sourceEnd === 0) return null;
  const source = line.slice(0, sourceEnd);
  const open = skipWs(sourceEnd);
  if (open < n && isOpen(line[open])) {
    // The source label ends at the first closing bracket the rest of the line accepts.
    for (let c = open + 1; c < n && !isLineTerminator(line.charCodeAt(c)); c++) {
      if (!isClose(line[c])) continue;
      const rest = afterSource(c + 1);
      if (rest) return [line, source, line.slice(sourceEnd, c + 1), ...rest];
    }
  }
  const rest = afterSource(sourceEnd);
  return rest ? [line, source, undefined, ...rest] : null;
}

/** A node in a flowchart statement: its ID and its raw label, if any. */
type StatementNode = [id: string, label: string | undefined];

/** Edges one link may expand to between two `&` groups. */
const MAX_GROUP_EDGES = 10_000;

const isLinkChar = (c: string | undefined) => c === "-" || c === "=" || c === ".";

/**
 * Matches the flowchart statements matchFlowchartEdge doesn't: chains
 * (`A --> B --> C`), text between the dashes (`A -- text --> B`, also `==`
 * and `-.`), and `&` groups (`A --> B & C`), whose every node links to every
 * node across the arrow. Returns the edges as [source, edge label, target],
 * or null if the whole line isn't such a statement. The line is scanned once,
 * left to right, so its length can't stall the server the way the old edge
 * pattern did.
 */
function matchFlowchartChain(line: string): [StatementNode, string | undefined, StatementNode][] | null {
  const n = line.length;
  let i = 0;
  const skipWs = (j: number) => {
    while (j < n && isWs(line.charCodeAt(j))) j++;
    return j;
  };

  const node = (): StatementNode | null => {
    const start = i;
    while (i < n && isIdChar(line.charCodeAt(i))) i++;
    if (i === start) return null;
    const id = line.slice(start, i);
    const open = skipWs(i);
    if (open === n || !isOpen(line[open])) return [id, undefined];
    // The label runs to its first closing bracket, and takes the ones right after it: `((x))`.
    let end = open + 1;
    while (end < n && !isClose(line[end])) end++;
    if (end === n) return null;
    while (end < n && isClose(line[end])) end++;
    const label = line.slice(i, end);
    i = end;
    return [id, label];
  };

  const group = (): StatementNode[] | null => {
    const members: StatementNode[] = [];
    for (;;) {
      const member = node();
      if (!member) return null;
      members.push(member);
      const amp = skipWs(i);
      if (line[amp] !== "&") return members;
      i = skipWs(amp + 1);
    }
  };

  // An arrow, `[-=.][-=.]+` and an optional head. `o` and `x` are heads only
  // when no ID runs on from them: in `A --x B` it's a head, in `A --xB` the target.
  const arrow = (): boolean => {
    let k = i;
    while (k < n && isLinkChar(line[k])) k++;
    if (k - i < 2) return false;
    if (line[k] === ">" || ((line[k] === "o" || line[k] === "x") && !(k + 1 < n && isIdChar(line.charCodeAt(k + 1))))) k++;
    i = k;
    return true;
  };

  // A link: `-- text -->`, or an arrow and an optional `|label|`.
  const link = (): { label?: string } | null => {
    i = skipWs(i);
    if (line[i] !== "-" && line[i] !== "=") return null;
    if (isLinkChar(line[i + 1]) && line[i + 2] !== undefined && isWs(line.charCodeAt(i + 2))) {
      // The text ends at the first run of two link characters after a space.
      const textStart = i + 2;
      let k = textStart + 1;
      while (k < n && !(isWs(line.charCodeAt(k - 1)) && isLinkChar(line[k]) && isLinkChar(line[k + 1]))) k++;
      if (k === n) return null;
      const label = line.slice(textStart, k);
      i = k;
      return arrow() ? { label } : null;
    }
    if (!arrow()) return null;
    const bar = skipWs(i);
    if (line[bar] !== "|") return {};
    const close = line.indexOf("|", bar + 1);
    if (close === -1) return null;
    i = close + 1;
    return { label: line.slice(bar + 1, close) };
  };

  const edges: [StatementNode, string | undefined, StatementNode][] = [];
  let sources = group();
  if (!sources) return null;
  for (;;) {
    const l = link();
    if (!l) return null;
    i = skipWs(i);
    const targets = group();
    if (!targets) return null;
    if (sources.length * targets.length > MAX_GROUP_EDGES) {
      throw new Error(`Mermaid link from ${sources.length} nodes to ${targets.length} exceeds ${MAX_GROUP_EDGES} edges`);
    }
    for (const s of sources) for (const t of targets) edges.push([s, l.label, t]);
    sources = targets;
    let end = skipWs(i);
    if (line[end] === ";") end = skipWs(end + 1);
    if (end === n) return edges;
  }
}

function parseFlowchartLine(
  line: string,
  nodes: Map<string, MermaidNode>,
  edges: MermaidEdge[],
): void {
  const addNode = ([id, rawLabel]: StatementNode): string => {
    const norm = normalizeId(id);
    const label = extractLabel(rawLabel);
    if (!nodes.has(norm)) {
      nodes.set(norm, { id: norm, label });
    } else if (label && !nodes.get(norm)!.label) {
      nodes.get(norm)!.label = label;
    }
    return norm;
  };

  // More permissive than Mermaid: extract source, arrow+label, target
  const parts = matchFlowchartEdge(line);
  if (parts) {
    const [, srcId, srcLabel, , edgeLabel, tgtId, tgtLabel] = parts;
    const from = addNode([srcId, srcLabel]);
    const to = addNode([tgtId, tgtLabel]);
    edges.push({ from, to, label: edgeLabel?.trim() });
    return;
  }

  for (const [src, edgeLabel, tgt] of matchFlowchartChain(line) ?? []) {
    const from = addNode(src);
    const to = addNode(tgt);
    edges.push({ from, to, label: edgeLabel?.trim() });
  }
}

/**
 * A state transition: StateA --> StateB : event, with [*] as a node marker.
 * The event used to be `:\s*(.+)`, whose `\s*` and `.+` both match spaces: a
 * line whose event breaks at a line terminator tried every split of the
 * spaces before it, a quadratic stall in the server. The event now starts at
 * its first non-space; the second branch is what `.+` took from a line that
 * ends in spaces (one of them, not a line terminator), so the captures are
 * the old pattern's. Exported for tests.
 */
export const STATE_TRANSITION =
  /^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)\s*(?::\s*(\S.*|[^\S\n\r\u2028\u2029]))?$/;

function parseStateLine(
  line: string,
  nodes: Map<string, MermaidNode>,
  edges: MermaidEdge[],
): void {
  const parts = line.match(STATE_TRANSITION);
  if (!parts) return;

  const [, srcRaw, tgtRaw, event] = parts;
  const srcNorm = normalizeId(srcRaw);
  const tgtNorm = normalizeId(tgtRaw);

  if (!nodes.has(srcNorm)) nodes.set(srcNorm, { id: srcNorm });
  if (!nodes.has(tgtNorm)) nodes.set(tgtNorm, { id: tgtNorm });

  edges.push({ from: srcNorm, to: tgtNorm, label: event?.trim() });
}

/**
 * A label's text: [Label], (Label), {Label}, ((Label)) and so on, stripped of
 * its brackets and the spaces inside them. What
 * /^[\[({]+\s*(.*?)\s*[\])}]+$/ captured from the trimmed label, scanned
 * once: the pattern's lazy middle and the \s* after it rescanned a run of
 * spaces for every character before it (131,072 spaces took 13.9 s).
 */
function extractLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  let opens = 0;
  while (opens < t.length && isOpen(t[opens])) opens++;
  let closes = t.length;
  while (closes > opens && isClose(t[closes - 1])) closes--;
  if (opens === 0 || closes === t.length) return undefined;
  let start = opens;
  while (start < closes && isWs(t.charCodeAt(start))) start++;
  let end = closes;
  while (end > start && isWs(t.charCodeAt(end - 1))) end--;
  // `.` matches no line terminator; the spaces around the text may hold one.
  for (let i = start; i < end; i++) if (isLineTerminator(t.charCodeAt(i))) return undefined;
  return t.slice(start, end) || undefined;
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
