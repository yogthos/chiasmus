import { readFileSync, statSync } from "node:fs";
import { extractGraph } from "./extractor.js";
import { graphToProlog } from "./facts.js";
import { loadSnapshot, saveSnapshot, type CacheOptions } from "./cache.js";
import { detectCommunities } from "./community.js";
import { detectHubs, detectBridges, detectSurprisingConnections } from "./insights.js";
import { graphDiff } from "./diff.js";
import {
  cycles as nativeCycles,
  reachability as nativeReachability,
  path as nativePath,
  impact as nativeImpact,
  deadCode as nativeDeadCode,
  callers as nativeCallers,
  callees as nativeCallees,
} from "./native-analyses.js";
import type { CodeGraph } from "./types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Maximum byte size of a `facts` analysis response. Above this the Prolog
 * program dump is refused and an error object is returned instead, because
 * MCP stdio transport + JSON serialization chokes on multi-megabyte strings.
 * Keep this aligned with MAX_FILE_SIZE so a single huge file can't
 * single-handedly exceed it, and with the "10 MB is fine" agreed budget.
 */
export const DEFAULT_FACTS_MAX_BYTES = 10 * 1024 * 1024;

/** Shape returned when the facts program exceeds the configured cap. */
export interface FactsOversizeError {
  error: string;
  size: number;
  limit: number;
}

/**
 * Build the facts analysis result, enforcing a size cap. Returns the raw
 * Prolog program string if under the cap, otherwise a structured error so
 * callers (and the MCP transport) can surface a clear failure instead of
 * timing out mid-serialize.
 */
export function buildFactsResult(
  graph: CodeGraph,
  entryPoints: string[] | undefined,
  maxBytes: number = DEFAULT_FACTS_MAX_BYTES,
): string | FactsOversizeError {
  const program = graphToProlog(graph, entryPoints);
  if (program.length > maxBytes) {
    return {
      error:
        `Prolog fact dump is ${program.length} bytes, exceeds the ${maxBytes} byte cap. ` +
        "Narrow the file set, or run a specific analysis (cycles, impact, callers, etc.) " +
        "directly instead of exporting raw facts.",
      size: program.length,
      limit: maxBytes,
    };
  }
  return program;
}

export type AnalysisType =
  | "summary" | "callers" | "callees" | "reachability"
  | "dead-code" | "cycles" | "path" | "impact" | "facts"
  | "layer-violation"
  | "communities" | "hubs" | "bridges" | "surprises"
  | "diff";

export interface AnalysisRequest {
  analysis: AnalysisType;
  target?: string;
  from?: string;
  to?: string;
  entryPoints?: string[];
  /** Snapshot name to diff against (required when analysis="diff"). */
  against?: string;
  /**
   * When set, the extracted graph is saved under this snapshot name after
   * analysis completes. Useful for capturing a baseline ("main") that a
   * later `diff` call can compare against.
   */
  saveSnapshot?: string;
  /**
   * Enable persistent per-file extraction cache. Supply an object (with
   * optional cacheDir/repoKey/budget overrides) to opt in. Omit or pass
   * undefined to extract fresh every call.
   */
  cache?: CacheOptions;
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

  const graph = await extractGraph(files, request.cache ? { cache: request.cache } : {});

  if (request.saveSnapshot) {
    if (!request.cache) {
      warnings.push(
        "saveSnapshot ignored: cache option is required to persist snapshots",
      );
    } else {
      try {
        await saveSnapshot(request.saveSnapshot, graph, request.cache);
      } catch (e: unknown) {
        warnings.push(
          `Failed to save snapshot ${request.saveSnapshot}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

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

/**
 * Core analysis pipeline — shared by runAnalysis and runAnalysisFromGraph.
 *
 * Reachability-heavy analyses (cycles, reachability, path, impact,
 * dead-code, callers, callees) run through native O(V+E) algorithms in
 * native-analyses.ts. The Prolog rule set is still emitted by
 * graphToProlog so `facts` output remains usable with chiasmus_verify.
 */
async function runOnGraph(
  graph: CodeGraph,
  request: AnalysisRequest,
): Promise<AnalysisResult> {
  switch (request.analysis) {
    case "facts":
      return { analysis: "facts", result: buildFactsResult(graph, request.entryPoints) };

    case "summary":
      return { analysis: "summary", result: buildSummary(graph) };

    case "layer-violation":
      return { analysis: "layer-violation", result: findLayerViolations(graph) };

    case "callers":
      if (!request.target) return missingParams("callers");
      return { analysis: "callers", result: nativeCallers(graph, request.target) };

    case "callees":
      if (!request.target) return missingParams("callees");
      return { analysis: "callees", result: nativeCallees(graph, request.target) };

    case "reachability":
      if (!request.from || !request.to) return missingParams("reachability");
      return {
        analysis: "reachability",
        result: { reachable: nativeReachability(graph, request.from, request.to) },
      };

    case "dead-code":
      return { analysis: "dead-code", result: nativeDeadCode(graph, request.entryPoints) };

    case "cycles":
      return { analysis: "cycles", result: nativeCycles(graph) };

    case "path":
      if (!request.from || !request.to) return missingParams("path");
      return { analysis: "path", result: { paths: nativePath(graph, request.from, request.to) } };

    case "impact":
      if (!request.target) return missingParams("impact");
      return { analysis: "impact", result: nativeImpact(graph, request.target) };

    case "communities":
      return { analysis: "communities", result: detectCommunities(graph) };

    case "hubs":
      return { analysis: "hubs", result: detectHubs(graph) };

    case "bridges":
      return { analysis: "bridges", result: detectBridges(graph) };

    case "surprises":
      return { analysis: "surprises", result: detectSurprisingConnections(graph) };

    case "diff": {
      if (!request.against) {
        return { analysis: "diff", result: { error: "Missing required parameter 'against' — specify a snapshot name to diff against" } };
      }
      if (!request.cache) {
        return { analysis: "diff", result: { error: "diff requires a cache option so snapshots can be located on disk" } };
      }
      const baseline = await loadSnapshot(request.against, request.cache);
      if (!baseline) {
        return { analysis: "diff", result: { error: `Snapshot '${request.against}' not found. Save one first via saveSnapshot.` } };
      }
      return { analysis: "diff", result: graphDiff(baseline, graph) };
    }

    default:
      return { analysis: request.analysis, result: { error: `Unknown analysis: ${request.analysis}` } };
  }
}

function missingParams(analysis: AnalysisType): AnalysisResult {
  return { analysis, result: { error: "Missing required parameters" } };
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

