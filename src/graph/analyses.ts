import { readFileSync } from "node:fs";
import { extractGraph } from "./extractor.js";
import { graphToProlog } from "./facts.js";
import { createPrologSolver } from "../solvers/prolog-solver.js";
import type { SolverResult, PrologAnswer } from "../solvers/types.js";
import type { CodeGraph } from "./types.js";

export type AnalysisType =
  | "summary" | "callers" | "callees" | "reachability"
  | "dead-code" | "cycles" | "path" | "impact" | "facts";

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
}

/** Run a graph analysis on the given source files */
export async function runAnalysis(
  filePaths: string[],
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  // Read files from disk
  const files = filePaths.map((p) => ({
    path: p,
    content: readFileSync(p, "utf-8"),
  }));

  const graph = extractGraph(files);
  const program = graphToProlog(graph, request.entryPoints);

  if (request.analysis === "facts") {
    return { analysis: "facts", result: program };
  }

  if (request.analysis === "summary") {
    return {
      analysis: "summary",
      result: buildSummary(graph),
    };
  }

  const query = buildQuery(request);
  if (!query) {
    return { analysis: request.analysis, result: { error: "Missing required parameters" } };
  }

  const solver = createPrologSolver();
  try {
    const solverResult = await solver.solve({ type: "prolog", program, query });
    return { analysis: request.analysis, result: formatResult(request.analysis, solverResult) };
  } finally {
    solver.dispose();
  }
}

/** Also accept pre-built graph + program for testing without file I/O */
export async function runAnalysisFromGraph(
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

  const query = buildQuery(request);
  if (!query) {
    return { analysis: request.analysis, result: { error: "Missing required parameters" } };
  }

  const solver = createPrologSolver();
  try {
    const solverResult = await solver.solve({ type: "prolog", program, query });
    return { analysis: request.analysis, result: formatResult(request.analysis, solverResult) };
  } finally {
    solver.dispose();
  }
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
      return `caller_of(${request.target}, X).`;

    case "callees":
      if (!request.target) return null;
      return `callee_of(${request.target}, X).`;

    case "reachability":
      if (!request.from || !request.to) return null;
      return `reaches(${request.from}, ${request.to}).`;

    case "dead-code":
      return "dead(X).";

    case "cycles":
      return "reaches(X, X).";

    case "path":
      if (!request.from || !request.to) return null;
      return `path(${request.from}, ${request.to}, Path).`;

    case "impact":
      if (!request.target) return null;
      return `reaches(X, ${request.target}).`;

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
