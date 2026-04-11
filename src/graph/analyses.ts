import { readFileSync, statSync } from "node:fs";
import { extractGraph } from "./extractor.js";
import { graphToProlog, escapeAtom } from "./facts.js";
import { createPrologSolver } from "../solvers/prolog-solver.js";
import type { SolverResult, PrologAnswer } from "../solvers/types.js";
import type { CodeGraph } from "./types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Graph analyses run system-generated Prolog (not user input) and walk
// cycle-safe reachability rules that are O(n²) per step. The default
// 100 000 inference budget gets exhausted on mid-size codebases (a few
// hundred functions), so we raise it for analyses.
const GRAPH_MAX_INFERENCES = 5_000_000;

export type AnalysisType =
  | "summary" | "callers" | "callees" | "reachability"
  | "dead-code" | "cycles" | "path" | "impact" | "facts"
  | "layer-violation";

export interface AnalysisRequest {
  analysis: AnalysisType;
  target?: string;
  from?: string;
  to?: string;
  entryPoints?: string[];
}

export interface AnalysisResult {
  analysis: AnalysisType;
  result: unknown;
  /** Non-fatal issues encountered while loading source files (missing, unreadable, oversized). */
  warnings?: string[];
}

/** Run a graph analysis on the given source files */
export async function runAnalysis(
  filePaths: string[],
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  // Read files from disk with size check
  const files: Array<{ path: string; content: string }> = [];
  const warnings: string[] = [];
  for (const p of filePaths) {
    try {
      const stat = statSync(p);
      if (stat.size > MAX_FILE_SIZE) {
        warnings.push(`Skipped ${p}: file exceeds ${MAX_FILE_SIZE} bytes`);
        continue;
      }
      files.push({ path: p, content: readFileSync(p, "utf-8") });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Skipped ${p}: ${msg}`);
    }
  }

  // If the caller supplied paths but nothing survived the filter, surface
  // an explicit error rather than silently returning an empty graph —
  // callers would otherwise see `{ functions: 0 }` and assume success.
  if (filePaths.length > 0 && files.length === 0) {
    return {
      analysis: request.analysis,
      result: { error: "No files could be read" },
      warnings,
    };
  }

  const graph = await extractGraph(files);
  const base = await runOnGraph(graph, request);
  return warnings.length > 0 ? { ...base, warnings } : base;
}

/** Also accept pre-built graph + program for testing without file I/O */
export async function runAnalysisFromGraph(
  graph: CodeGraph,
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  return runOnGraph(graph, request);
}

/** Core analysis pipeline — shared by runAnalysis and runAnalysisFromGraph. */
async function runOnGraph(
  graph: CodeGraph,
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  const program = graphToProlog(graph, request.entryPoints);

  if (request.analysis === "facts") {
    return { analysis: "facts", result: program };
  }

  if (request.analysis === "summary") {
    return { analysis: "summary", result: buildSummary(graph) };
  }

  if (request.analysis === "layer-violation") {
    return { analysis: "layer-violation", result: findLayerViolations(graph) };
  }

  const query = buildQuery(request);
  if (!query) {
    return { analysis: request.analysis, result: { error: "Missing required parameters" } };
  }

  const solver = createPrologSolver();
  try {
    const solverResult = await solver.solve({
      type: "prolog",
      program,
      query,
      maxInferences: GRAPH_MAX_INFERENCES,
    });
    return { analysis: request.analysis, result: formatResult(request.analysis, solverResult) };
  } finally {
    solver.dispose();
  }
}

const LAYER_ORDER: Record<string, number> = {
  handlers: 0,
  routes: 0,
  controllers: 0,
  services: 1,
  repositories: 2,
  db: 3,
  models: 3,
};

interface LayerViolation {
  caller: string;
  callee: string;
  callerLayer: string;
  calleeLayer: string;
}

function extractLayer(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg in LAYER_ORDER) return seg;
  }
  return null;
}

function findLayerViolations(graph: CodeGraph): LayerViolation[] {
  const funcLayers = new Map<string, string>();
  for (const d of graph.defines) {
    const layer = extractLayer(d.file);
    if (layer) funcLayers.set(d.name, layer);
  }

  const violations: LayerViolation[] = [];
  for (const c of graph.calls) {
    const callerLayer = funcLayers.get(c.caller);
    const calleeLayer = funcLayers.get(c.callee);
    if (!callerLayer || !calleeLayer) continue;
    if (callerLayer === calleeLayer) continue;

    const callerOrder = LAYER_ORDER[callerLayer] ?? 0;
    const calleeOrder = LAYER_ORDER[calleeLayer] ?? 0;

    if (calleeOrder - callerOrder > 1) {
      violations.push({
        caller: c.caller,
        callee: c.callee,
        callerLayer,
        calleeLayer,
      });
    }
  }

  return violations;
}

function buildSummary(graph: CodeGraph) {
  const files = new Set(graph.defines.map((d) => d.file));
  const functions = graph.defines.filter((d) => d.kind === "function" || d.kind === "method").length;
  const classes = graph.defines.filter((d) => d.kind === "class").length;
  return {
    files: files.size,
    functions,
    classes,
    callEdges: graph.calls.length,
    imports: graph.imports.length,
    exports: graph.exports.length,
  };
}

function buildQuery(request: AnalysisRequest): string | null {
  switch (request.analysis) {
    case "callers":
      if (!request.target) return null;
      return `caller_of(${escapeAtom(request.target)}, X).`;

    case "callees":
      if (!request.target) return null;
      return `callee_of(${escapeAtom(request.target)}, X).`;

    case "reachability":
      if (!request.from || !request.to) return null;
      return `reaches(${escapeAtom(request.from)}, ${escapeAtom(request.to)}).`;

    case "dead-code":
      return "dead(X).";

    case "cycles":
      return "func_reaches(X, X).";

    case "path":
      if (!request.from || !request.to) return null;
      return `path(${escapeAtom(request.from)}, ${escapeAtom(request.to)}, Path).`;

    case "impact":
      if (!request.target) return null;
      return `reaches(X, ${escapeAtom(request.target)}).`;

    default:
      return null;
  }
}

function formatResult(analysis: AnalysisType, solverResult: SolverResult): unknown {
  if (solverResult.status === "error") {
    return { error: solverResult.error };
  }

  if (solverResult.status !== "success") {
    return { error: `Unexpected solver status: ${solverResult.status}` };
  }

  const answers = solverResult.answers;

  switch (analysis) {
    case "callers":
    case "callees":
    case "dead-code":
      return extractUniqueValues(answers, "X");

    case "reachability":
      return { reachable: answers.length > 0 };

    case "cycles": {
      return extractUniqueValues(answers, "X");
    }

    case "path": {
      if (answers.length === 0) return { paths: [] };
      // Path binding is a Prolog list — parse it
      return {
        paths: answers.map((a) => a.bindings.Path ?? a.formatted),
      };
    }

    case "impact":
      return extractUniqueValues(answers, "X");

    default:
      return answers.map((a) => a.bindings);
  }
}

function extractUniqueValues(answers: PrologAnswer[], variable: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const a of answers) {
    const val = a.bindings[variable];
    if (val && !seen.has(val)) {
      seen.add(val);
      result.push(val);
    }
  }
  return result;
}
