/**
 * Codebase map projections over a CodeGraph.
 *
 * The map layer is a read-only view — it doesn't parse, read files, or
 * touch the cache. It takes an already-extracted `CodeGraph` and shapes it
 * into summaries an LLM can consume directly instead of reading source:
 *
 *   - buildOverview(graph)   → repo outline (dir tree + per-file headlines)
 *   - buildFileDetail(graph) → single file (exports, imports, all symbols)
 *   - buildSymbolDetail(..)  → symbol by name (defs + callers + callees)
 *
 * All three return plain objects; renderMap serializes to markdown or JSON.
 */

import type { CodeGraph, DefinesFact, ImportsFact } from "./types.js";

const DEFAULT_MAX_EXPORTS_PER_FILE = 8;
const DEFAULT_DOC_LEN = 160;

export interface SymbolEntry {
  name: string;
  kind: string;
  line: number;
  signature?: string;
}

export interface OverviewFile {
  path: string;
  language: string;
  lines?: number;
  tokens?: number;
  doc?: string;
  exportCount: number;
  topExports: SymbolEntry[];
}

export interface OverviewSummary {
  files: number;
  languages: string[];
  tokens: number;
  definitions: number;
  exports: number;
}

export interface DirNode {
  name: string;
  dirs: DirNode[];
  files: OverviewFile[];
}

export interface OverviewMap {
  kind: "overview";
  summary: OverviewSummary;
  files: OverviewFile[];
  root: DirNode;
}

export interface FileDetail {
  kind: "file";
  path: string;
  language: string;
  lines?: number;
  tokens?: number;
  doc?: string;
  exports: SymbolEntry[];
  imports: Array<{ name: string; source: string }>;
  symbols: SymbolEntry[];
}

export interface SymbolDetail {
  kind: "symbol";
  name: string;
  defines: Array<{ file: string; kind: string; line: number; signature?: string }>;
  callers: string[];
  callees: string[];
}

export interface BuildOverviewOptions {
  /** Path patterns. String or array. `**`, `*`, `?` supported. */
  include?: string | string[];
  /** Max exports surfaced per file in the overview (default 8). */
  maxExportsPerFile?: number;
}

/**
 * Build a repo-wide overview from a CodeGraph. Files with no FileNode
 * (e.g. unsupported languages filtered out during extraction) are dropped.
 */
export function buildOverview(
  graph: CodeGraph,
  opts: BuildOverviewOptions = {},
): OverviewMap {
  const maxExports = opts.maxExportsPerFile ?? DEFAULT_MAX_EXPORTS_PER_FILE;
  const includeGlobs = normalizeInclude(opts.include);
  const fileNodes = (graph.files ?? []).filter((f) =>
    includeGlobs.length === 0 || includeGlobs.some((g) => globMatch(f.path, g)),
  );

  const definesByFile = groupBy(graph.defines, (d) => d.file);
  const exportNames = groupBy(graph.exports, (e) => e.file, (e) => e.name);

  const files: OverviewFile[] = fileNodes
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((fn) => {
      const defs = definesByFile.get(fn.path) ?? [];
      // Dedup exports by name (graph.exports can repeat when a name is
      // re-exported through multiple specifiers); both exportCount and
      // summary.exports below must agree on the same denominator.
      const expSet = new Set(exportNames.get(fn.path) ?? []);
      // Rank: exports backed by a define first (kind-weighted), then line
      // order. Type-only exports (no matching define — e.g. bare TS
      // interfaces) are excluded from topExports because we have no line
      // or signature for them, but they still count toward exportCount.
      const ranked = defs
        .filter((d) => expSet.has(d.name))
        .sort((a, b) => kindPriority(a.kind) - kindPriority(b.kind) || a.line - b.line)
        .map(toSymbolEntry);
      return {
        path: fn.path,
        language: fn.language,
        lines: fn.lineCount,
        tokens: fn.tokenEstimate,
        doc: truncateDoc(fn.fileDoc),
        exportCount: expSet.size,
        topExports: ranked.slice(0, maxExports),
      };
    });

  const languages = Array.from(new Set(fileNodes.map((f) => f.language))).sort();
  const totalTokens = fileNodes.reduce((acc, f) => acc + (f.tokenEstimate ?? 0), 0);
  // Sum per-file unique export counts so summary matches the file list.
  const exportCount = files.reduce((acc, f) => acc + f.exportCount, 0);
  const allowedPaths = new Set(fileNodes.map((f) => f.path));
  const defineCount = graph.defines.filter((d) => allowedPaths.has(d.file)).length;

  return {
    kind: "overview",
    summary: {
      files: fileNodes.length,
      languages,
      tokens: totalTokens,
      definitions: defineCount,
      exports: exportCount,
    },
    files,
    root: buildDirTree(files),
  };
}

/**
 * Build a single-file detail view. Returns null when the graph has no
 * FileNode for the given path (the file was never extracted, or got
 * filtered out as an unsupported language).
 */
export function buildFileDetail(graph: CodeGraph, path: string): FileDetail | null {
  const fileNode = (graph.files ?? []).find((f) => f.path === path);
  if (!fileNode) return null;

  const fileDefines = graph.defines.filter((d) => d.file === path);
  const fileExports = new Set(graph.exports.filter((e) => e.file === path).map((e) => e.name));
  const fileImports = graph.imports.filter((i) => i.file === path);

  const exports = fileDefines
    .filter((d) => fileExports.has(d.name))
    .sort((a, b) => a.line - b.line)
    .map(toSymbolEntry);

  const symbols = fileDefines
    .slice()
    .sort((a, b) => a.line - b.line)
    .map(toSymbolEntry);

  const imports = dedupeImports(fileImports).sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  });

  return {
    kind: "file",
    path,
    language: fileNode.language,
    lines: fileNode.lineCount,
    tokens: fileNode.tokenEstimate,
    doc: truncateDoc(fileNode.fileDoc),
    exports,
    imports,
    symbols,
  };
}

/**
 * Build a symbol-level detail: where the name is defined, who calls it,
 * what it calls. Operates on the raw calls list so it works on any graph
 * shape (no extra indexing required).
 */
export function buildSymbolDetail(graph: CodeGraph, name: string): SymbolDetail {
  const defines = graph.defines
    .filter((d) => d.name === name)
    .map((d) => ({ file: d.file, kind: d.kind, line: d.line, signature: d.signature }));

  const callers = Array.from(
    new Set(graph.calls.filter((c) => c.callee === name).map((c) => c.caller)),
  ).sort();

  const callees = Array.from(
    new Set(graph.calls.filter((c) => c.caller === name).map((c) => c.callee)),
  ).sort();

  return { kind: "symbol", name, defines, callers, callees };
}

export type MapFormat = "markdown" | "json";
export type AnyMap = OverviewMap | FileDetail | SymbolDetail;

export function renderMap(map: AnyMap, format: MapFormat): string {
  if (format === "json") return JSON.stringify(map, null, 2);
  switch (map.kind) {
    case "overview":
      return renderOverviewMd(map);
    case "file":
      return renderFileMd(map);
    case "symbol":
      return renderSymbolMd(map);
  }
}

// ── Markdown renderers ──────────────────────────────────────────────

function renderOverviewMd(m: OverviewMap): string {
  const lines: string[] = [];
  lines.push("# Codebase overview");
  lines.push("");
  const s = m.summary;
  lines.push(
    `**Files:** ${s.files} · **Token budget:** ~${formatTokens(s.tokens)} · ` +
    `**Definitions:** ${s.definitions} · **Exports:** ${s.exports}`,
  );
  if (s.languages.length > 0) {
    lines.push(`**Languages:** ${s.languages.join(", ")}`);
  }
  lines.push("");
  for (const f of m.files) {
    lines.push(renderFileHeadline(f));
    if (f.doc) lines.push(`  ${f.doc}`);
    if (f.topExports.length > 0) {
      for (const ex of f.topExports) {
        lines.push(`  - ${renderSymbolLine(ex)}`);
      }
      if (f.exportCount > f.topExports.length) {
        lines.push(`  - … and ${f.exportCount - f.topExports.length} more export(s)`);
      }
    }
  }
  return lines.join("\n");
}

function renderFileMd(f: FileDetail): string {
  const lines: string[] = [];
  lines.push(`# ${f.path}`);
  lines.push("");
  lines.push(
    `**Language:** ${f.language}` +
    (f.lines !== undefined ? ` · **Lines:** ${f.lines}` : "") +
    (f.tokens !== undefined ? ` · **Tokens:** ~${formatTokens(f.tokens)}` : ""),
  );
  if (f.doc) {
    lines.push("");
    lines.push(f.doc);
  }
  if (f.exports.length > 0) {
    lines.push("");
    lines.push("## Exports");
    for (const ex of f.exports) lines.push(`- ${renderSymbolLine(ex)}`);
  }
  if (f.imports.length > 0) {
    lines.push("");
    lines.push("## Imports");
    const bySource = new Map<string, string[]>();
    for (const i of f.imports) {
      const arr = bySource.get(i.source) ?? [];
      arr.push(i.name);
      bySource.set(i.source, arr);
    }
    for (const [source, names] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- \`${source}\`: ${names.join(", ")}`);
    }
  }
  if (f.symbols.length > 0) {
    lines.push("");
    lines.push("## Symbols");
    for (const s of f.symbols) lines.push(`- ${renderSymbolLine(s)}`);
  }
  return lines.join("\n");
}

function renderSymbolMd(s: SymbolDetail): string {
  const lines: string[] = [];
  lines.push(`# ${s.name}`);
  if (s.defines.length === 0) {
    lines.push("");
    lines.push("*No definitions found in the graph.*");
  } else {
    lines.push("");
    lines.push("## Defined in");
    for (const d of s.defines) {
      const sig = d.signature ? ` ${d.signature}` : "";
      lines.push(`- \`${d.file}:${d.line}\` — ${d.kind}${sig}`);
    }
  }
  if (s.callers.length > 0) {
    lines.push("");
    lines.push("## Callers");
    for (const c of s.callers) lines.push(`- \`${c}\``);
  }
  if (s.callees.length > 0) {
    lines.push("");
    lines.push("## Callees");
    for (const c of s.callees) lines.push(`- \`${c}\``);
  }
  return lines.join("\n");
}

function renderFileHeadline(f: OverviewFile): string {
  const bits: string[] = [f.language];
  if (f.lines !== undefined) bits.push(`${f.lines} lines`);
  if (f.tokens !== undefined) bits.push(`~${formatTokens(f.tokens)} tok`);
  if (f.exportCount > 0) bits.push(`${f.exportCount} export${f.exportCount === 1 ? "" : "s"}`);
  return `- \`${f.path}\` (${bits.join(", ")})`;
}

function renderSymbolLine(s: SymbolEntry): string {
  const sig = s.signature ? ` \`${s.signature}\`` : "";
  return `**${s.name}**${sig} — ${s.kind} @ L${s.line}`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function toSymbolEntry(d: DefinesFact): SymbolEntry {
  return { name: d.name, kind: d.kind, line: d.line, signature: d.signature };
}

function kindPriority(kind: string): number {
  switch (kind) {
    case "class":
    case "interface":
      return 0;
    case "function":
      return 1;
    case "method":
      return 2;
    case "variable":
      return 3;
    default:
      return 4;
  }
}

function dedupeImports(imports: ImportsFact[]): Array<{ name: string; source: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; source: string }> = [];
  for (const i of imports) {
    const key = `${i.source}::${i.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: i.name, source: i.source });
  }
  return out;
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Map<string, T[]>;
function groupBy<T, V>(items: T[], keyFn: (t: T) => string, valueFn: (t: T) => V): Map<string, V[]>;
function groupBy<T, V>(
  items: T[],
  keyFn: (t: T) => string,
  valueFn?: (t: T) => V,
): Map<string, (T | V)[]> {
  const out = new Map<string, (T | V)[]>();
  for (const it of items) {
    const k = keyFn(it);
    const arr = out.get(k) ?? [];
    arr.push(valueFn ? valueFn(it) : it);
    out.set(k, arr);
  }
  return out;
}

function truncateDoc(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const compact = doc.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.length > DEFAULT_DOC_LEN ? compact.slice(0, DEFAULT_DOC_LEN - 1) + "…" : compact;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function normalizeInclude(include: string | string[] | undefined): string[] {
  if (!include) return [];
  return Array.isArray(include) ? include : [include];
}

/**
 * Match a path against a simple glob. Supported:
 *   **  any run of characters including `/`
 *   *   any run of non-`/` characters
 *   ?   one non-`/` character
 * Everything else is matched literally.
 */
export function globMatch(path: string, pattern: string): boolean {
  const parts = pattern.split(/(\*\*|\*|\?)/).filter((s) => s.length > 0);
  let regex = "";
  for (const part of parts) {
    if (part === "**") regex += ".*";
    else if (part === "*") regex += "[^/]*";
    else if (part === "?") regex += "[^/]";
    else regex += part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + regex + "$").test(path);
}

// ── Dir tree ────────────────────────────────────────────────────────

function buildDirTree(files: OverviewFile[]): DirNode {
  const root: DirNode = { name: "", dirs: [], files: [] };
  for (const f of files) {
    const segments = f.path.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue;
    let cursor = root;
    for (const seg of segments) {
      let child = cursor.dirs.find((d) => d.name === seg);
      if (!child) {
        child = { name: seg, dirs: [], files: [] };
        cursor.dirs.push(child);
      }
      cursor = child;
    }
    cursor.files.push(f);
  }
  return root;
}
