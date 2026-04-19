// Portions adapted from pi-code-graph (MIT) https://github.com/picassio/pi-code-graph
// Original copyright: see LICENSE-pi-code-graph
//
// tsconfig.json path-alias resolver.
// Parses TypeScript `compilerOptions.paths` (and `baseUrl`) so that
// imports like `@/components/Button` can be rewritten to a repo-relative
// path (`src/components/Button`) before normal module resolution runs.
// Follows `extends` chains and is cycle-safe.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export interface TsconfigAliasMap {
  /** True iff at least one alias was loaded. */
  readonly hasAliases: boolean;
  /** Number of alias entries (diagnostic). */
  readonly size: number;
  /**
   * Try to rewrite an import path through the alias map.
   * Returns a repo-relative path (no leading "./"), or null if no alias matched.
   */
  rewrite(importPath: string): string | null;
}

export const EMPTY_TSCONFIG_ALIASES: TsconfigAliasMap = {
  hasAliases: false,
  size: 0,
  rewrite: () => null,
};

interface RawTsconfig {
  extends?: string;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

/** Strip // and /* * / comments from a JSONC blob. */
function stripJsonComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

function tryReadJson(filePath: string): RawTsconfig | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(stripJsonComments(raw)) as RawTsconfig;
  } catch {
    return null;
  }
}

/**
 * Resolve and merge a tsconfig file (recursively following `extends`).
 * Child wins for compilerOptions, but parent paths/baseUrl are inherited
 * when child does not override them. Cycle-safe via a `seen` set.
 */
function loadAndMerge(
  filePath: string,
  seen = new Set<string>(),
): {
  baseUrl: string | undefined;
  paths: Record<string, string[]>;
  configDir: string;
} | null {
  const abs = resolve(filePath);
  if (seen.has(abs)) return null;
  seen.add(abs);

  const cfg = tryReadJson(abs);
  if (!cfg) return null;

  const configDir = dirname(abs);

  let inherited: {
    baseUrl: string | undefined;
    paths: Record<string, string[]>;
    configDir: string;
  } | null = null;
  if (cfg.extends) {
    let extPath = cfg.extends;
    if (!extPath.endsWith(".json")) extPath += ".json";
    const extResolved = isAbsolute(extPath)
      ? extPath
      : resolve(configDir, extPath);
    inherited = loadAndMerge(extResolved, seen);
  }

  const co = cfg.compilerOptions ?? {};
  const baseUrl = co.baseUrl ?? inherited?.baseUrl;
  const paths: Record<string, string[]> = {
    ...(inherited?.paths ?? {}),
    ...(co.paths ?? {}),
  };

  return {
    baseUrl,
    paths,
    configDir: co.baseUrl ? configDir : inherited?.configDir ?? configDir,
  };
}

interface CompiledAlias {
  /** Prefix to match against the import (e.g. "@/"). Empty string == exact match. */
  prefix: string;
  /** Whether the original pattern was a `*` glob. */
  isGlob: boolean;
  /** Exact alias key (no trailing /*). Used when isGlob == false. */
  exact: string;
  /** Repo-relative target prefix (e.g. "src/"). */
  targetPrefix: string;
  /** Repo-relative exact target (when not glob). */
  targetExact: string;
}

/**
 * Load tsconfig path aliases for a repository. Returns
 * `EMPTY_TSCONFIG_ALIASES` if no usable tsconfig is found (graceful).
 */
export function loadTsconfigAliases(repoPath: string): TsconfigAliasMap {
  const candidates = [
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.base.json",
    "jsconfig.json",
  ];

  for (const filename of candidates) {
    const merged = loadAndMerge(join(repoPath, filename));
    if (!merged) continue;
    if (!merged.paths || Object.keys(merged.paths).length === 0) continue;

    const baseUrl = merged.baseUrl ?? ".";
    const baseAbs = resolve(merged.configDir, baseUrl);
    const repoRel = (p: string): string => {
      const abs = resolve(baseAbs, p);
      let rel = abs.startsWith(repoPath) ? abs.slice(repoPath.length) : abs;
      rel = rel.replace(/^[\\/]+/, "");
      return normalize(rel).replace(/\\/g, "/");
    };

    const compiled: CompiledAlias[] = [];
    for (const [pattern, targets] of Object.entries(merged.paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const rawTarget = String(targets[0]);
      const isGlob = pattern.endsWith("/*");
      const exact = isGlob ? pattern.slice(0, -2) : pattern;
      const prefix = isGlob ? pattern.slice(0, -1) : pattern;
      const targetExact = repoRel(
        rawTarget.endsWith("/*") ? rawTarget.slice(0, -2) : rawTarget,
      );
      const targetPrefix =
        repoRel(
          rawTarget.endsWith("/*") ? rawTarget.slice(0, -1) : rawTarget,
        ) + (rawTarget.endsWith("/*") ? "/" : "");
      compiled.push({ prefix, isGlob, exact, targetPrefix, targetExact });
    }

    if (compiled.length === 0) continue;

    // Longer prefixes first → most specific wins.
    compiled.sort((a, b) => b.prefix.length - a.prefix.length);

    return {
      hasAliases: true,
      size: compiled.length,
      rewrite(importPath: string): string | null {
        for (const a of compiled) {
          if (a.isGlob) {
            if (importPath === a.exact) return a.targetExact;
            if (importPath.startsWith(a.prefix)) {
              const rest = importPath.slice(a.prefix.length);
              return (a.targetPrefix + rest).replace(/\/+/g, "/");
            }
          } else if (importPath === a.exact) {
            return a.targetExact;
          }
        }
        return null;
      },
    };
  }

  return EMPTY_TSCONFIG_ALIASES;
}
