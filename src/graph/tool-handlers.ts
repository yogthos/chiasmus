/**
 * chiasmus_graph and chiasmus_map tool handlers. They parse source with
 * tree-sitter and run graph analyses — CPU-heavy work that runs in the graph
 * child process (see child-pool.ts) so the MCP server stays responsive.
 */

import { readFileSync, statSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runAnalysis, MAX_FILE_SIZE } from "./analyses.js";
import type { AnalysisType } from "./analyses.js";
import { defaultRepoKey } from "./cache.js";
import { extractGraph } from "./extractor.js";
import { buildOverview, buildFileDetail, buildSymbolDetail, renderMap } from "./map.js";
import type { MapFormat } from "./map.js";

export const GRAPH_ANALYSES = [
  "summary", "callers", "callees", "reachability",
  "dead-code", "cycles", "path", "impact",
  "layer-violation", "facts",
  "communities", "hubs", "bridges", "surprises",
  "diff", "entry-points",
] as const;

export async function handleGraph(args: Record<string, unknown>): Promise<CallToolResult> {
  const files = args.files;
  const analysis = args.analysis;

  if (!Array.isArray(files) || typeof analysis !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "Required: files (string[]), analysis (string)",
      }) }],
    };
  }

  if (files.some((f) => typeof f !== "string")) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "'files' must contain only strings",
      }) }],
    };
  }

  if (!(GRAPH_ANALYSES as readonly string[]).includes(analysis)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown analysis: ${analysis}. Use one of: ${GRAPH_ANALYSES.join(", ")}`,
      }) }],
    };
  }

  try {
    const cacheOpts = args.cache === true ? { repoKey: defaultRepoKey() } : undefined;
    const result = await runAnalysis(files as string[], {
      analysis: analysis as AnalysisType,
      target: args.target as string | undefined,
      from: args.from as string | undefined,
      to: args.to as string | undefined,
      entryPoints: args.entry_points as string[] | undefined,
      against: args.against as string | undefined,
      saveSnapshot: args.save_snapshot as string | undefined,
      includeInsights: args.include_insights as boolean | undefined,
      // `diff` and `save_snapshot` both require the cache to locate on-disk
      // state — auto-enable when either is set.
      cache: cacheOpts ?? ((args.save_snapshot || analysis === "diff") ? { repoKey: defaultRepoKey() } : undefined),
    });
    // Compact JSON: pretty-printing doubled payload size for no benefit and
    // large graph analyses hit MCP stdio transport limits.
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
}

export async function handleMap(args: Record<string, unknown>): Promise<CallToolResult> {
  const files = args.files;
  if (!Array.isArray(files) || files.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "'files' (non-empty string[]) is required",
      }) }],
    };
  }
  if (files.some((f) => typeof f !== "string")) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "'files' must contain only strings",
      }) }],
    };
  }

  const mode = (args.mode as string | undefined) ?? "overview";
  if (mode !== "overview" && mode !== "file" && mode !== "symbol") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown mode: ${mode}. Use 'overview', 'file', or 'symbol'.`,
      }) }],
    };
  }

  const format = (args.format as MapFormat | undefined) ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown format: ${format}. Use 'markdown' or 'json'.`,
      }) }],
    };
  }

  if (mode === "file" && typeof args.path !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "mode='file' requires 'path' (absolute file path)",
      }) }],
    };
  }
  if (mode === "symbol" && typeof args.name !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "mode='symbol' requires 'name' (symbol identifier)",
      }) }],
    };
  }

  // Read files from disk with the same guards `runAnalysis` applies.
  const loaded: Array<{ path: string; content: string }> = [];
  const warnings: string[] = [];
  for (const p of files as string[]) {
    try {
      const stat = statSync(p);
      if (stat.size > MAX_FILE_SIZE) {
        warnings.push(`Skipped ${p}: file exceeds ${MAX_FILE_SIZE} bytes`);
        continue;
      }
      loaded.push({ path: p, content: readFileSync(p, "utf-8") });
    } catch (e: unknown) {
      warnings.push(`Skipped ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (loaded.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "No files could be read",
        warnings,
      }) }],
    };
  }

  try {
    const cacheOpts = args.cache === true ? { repoKey: defaultRepoKey() } : undefined;
    const graph = await extractGraph(loaded, cacheOpts ? { cache: cacheOpts } : {});

    // Negative `max_exports` slices from the end (`ranked.slice(0, -1)`),
    // which is nonsensical. Clamp to ≥0 so the user gets "no top exports"
    // instead of "all except the last."
    const rawMax = typeof args.max_exports === "number" ? args.max_exports : undefined;
    const maxExportsPerFile = rawMax !== undefined ? Math.max(0, rawMax) : undefined;

    let payload: unknown;
    if (mode === "overview") {
      const include = Array.isArray(args.include)
        ? (args.include as unknown[]).filter((s): s is string => typeof s === "string")
        : undefined;
      payload = buildOverview(graph, { include, maxExportsPerFile });
    } else if (mode === "file") {
      const detail = buildFileDetail(graph, args.path as string);
      if (!detail) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `No FileNode for path '${args.path}'. Ensure it was included in 'files' and is a supported language.`,
            warnings: warnings.length > 0 ? warnings : undefined,
          }) }],
        };
      }
      payload = detail;
    } else {
      payload = buildSymbolDetail(graph, args.name as string);
    }

    if (format === "json") {
      const withWarnings = warnings.length > 0 ? { ...(payload as object), warnings } : payload;
      return {
        content: [{ type: "text", text: JSON.stringify(withWarnings, null, 2) }],
      };
    }
    const rendered = renderMap(payload as Parameters<typeof renderMap>[0], "markdown");
    return {
      content: [{
        type: "text",
        text: warnings.length > 0
          ? `${rendered}\n\n---\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
          : rendered,
      }],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
}
