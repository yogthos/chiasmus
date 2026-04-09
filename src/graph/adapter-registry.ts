import { createRequire } from "node:module";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LanguageAdapter } from "./types.js";

const require = createRequire(import.meta.url);

const adapters = new Map<string, LanguageAdapter>();
const extToLanguage = new Map<string, string>();
let discovered = false;

/** Register a custom language adapter */
export function registerAdapter(adapter: LanguageAdapter): void {
  adapters.set(adapter.language, adapter);
  for (const ext of adapter.extensions) {
    const normalized = ext.startsWith(".") ? ext : `.${ext}`;
    extToLanguage.set(normalized.toLowerCase(), adapter.language);
  }
}

/** Get a registered adapter by language name */
export function getAdapter(language: string): LanguageAdapter | null {
  return adapters.get(language) ?? null;
}

/** Get a registered adapter by file extension */
export function getAdapterForExt(ext: string): LanguageAdapter | null {
  const lang = extToLanguage.get(ext.toLowerCase());
  if (!lang) return null;
  return adapters.get(lang) ?? null;
}

/** Get all registered adapter extensions */
export function getAdapterExtensions(): string[] {
  return [...extToLanguage.keys()];
}

/** Clear all registered adapters (for testing) */
export function clearAdapters(): void {
  adapters.clear();
  extToLanguage.clear();
  discovered = false;
}

/**
 * Auto-discover adapters from node_modules (chiasmus-adapter-*) and
 * optional searchPaths exported by discovered adapters.
 */
export async function discoverAdapters(): Promise<void> {
  if (discovered) return;
  discovered = true;

  // Find node_modules relative to this package
  let nodeModulesDir: string;
  try {
    const ownPkg = require.resolve("chiasmus/package.json");
    nodeModulesDir = resolve(ownPkg, "..", "..");
  } catch {
    // Fallback: walk up from this file
    nodeModulesDir = resolve(import.meta.url.replace("file://", ""), "..", "..", "..", "node_modules");
  }

  // Scan for chiasmus-adapter-* packages
  await scanDirectory(nodeModulesDir, "chiasmus-adapter-");

  // Follow searchPaths from any discovered adapters
  const pendingPaths: string[] = [];
  for (const adapter of adapters.values()) {
    if (adapter.searchPaths) {
      pendingPaths.push(...adapter.searchPaths);
    }
  }
  for (const searchPath of pendingPaths) {
    const resolved = resolve(searchPath);
    await scanDirectory(resolved, null);
  }
}

/**
 * Scan a directory for adapter modules.
 * If prefix is set, only load subdirectories matching that prefix (node_modules convention).
 * If prefix is null, load all .js/.mjs files directly (searchPaths convention).
 */
async function scanDirectory(dir: string, prefix: string | null): Promise<void> {
  if (!existsSync(dir)) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    try {
      if (prefix) {
        // node_modules mode: look for chiasmus-adapter-* packages
        if (!entry.startsWith(prefix)) continue;
        const pkgDir = join(dir, entry);
        if (!statSync(pkgDir).isDirectory()) continue;
        const mod = await loadAdapterModule(pkgDir);
        if (mod) registerFromModule(mod);
      } else {
        // searchPaths mode: load .js/.mjs files as adapter modules
        if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
        const filePath = join(dir, entry);
        if (!statSync(filePath).isFile()) continue;
        const mod = await import(filePath);
        if (mod) registerFromModule(mod);
      }
    } catch {
      // Skip adapters that fail to load
    }
  }
}

async function loadAdapterModule(pkgDir: string): Promise<any | null> {
  try {
    // Try to import the package by its directory
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    return await import(pkgDir);
  } catch {
    return null;
  }
}

function registerFromModule(mod: any): void {
  // Handle both default and named exports
  const candidate = mod.default ?? mod;

  if (Array.isArray(candidate)) {
    for (const adapter of candidate) {
      if (isLanguageAdapter(adapter)) {
        registerAdapter(adapter);
      }
    }
  } else if (isLanguageAdapter(candidate)) {
    registerAdapter(candidate);
  }

  // Also check named 'adapter' or 'adapters' exports
  if (mod.adapter && isLanguageAdapter(mod.adapter)) {
    registerAdapter(mod.adapter);
  }
  if (Array.isArray(mod.adapters)) {
    for (const a of mod.adapters) {
      if (isLanguageAdapter(a)) registerAdapter(a);
    }
  }
}

function isLanguageAdapter(obj: unknown): obj is LanguageAdapter {
  if (!obj || typeof obj !== "object") return false;
  const a = obj as Record<string, unknown>;
  return (
    typeof a.language === "string" &&
    Array.isArray(a.extensions) &&
    typeof a.grammar === "object" && a.grammar !== null &&
    typeof a.extract === "function"
  );
}
