import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { extname, resolve, dirname } from "node:path";
import { getAdapter, getAdapterForExt, getAdapterExtensions } from "./adapter-registry.js";

const require = createRequire(import.meta.url);

/**
 * Chiasmus package root. This file lives at `<root>/src/graph/parser.ts` in
 * dev and `<root>/dist/graph/parser.js` when published — two levels up from
 * either lands on the package root, where `grammars/` sits.
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Lazy-loaded tree-sitter parsers (native for CJS grammars, WASM for the lisps)
let NativeParser: any = null;
let nativeParserInstance: any = null;
let WasmParserClass: any = null;
let WasmLanguageClass: any = null;
let wasmParserInstance: any = null;
const languageCache = new Map<string, { lang: any; wasm: boolean }>();
/** Compiled WASM Languages keyed by .wasm path, so shared grammars compile once. */
const wasmLanguageByPath = new Map<string, any>();

interface LangConfig {
  /** npm package providing the grammar. Omitted for grammars vendored in `grammars/`. */
  package?: string;
  moduleExport?: string;
  wasm?: boolean;
  /**
   * WASM file, resolved inside `package` when one is given and against the
   * chiasmus package root otherwise.
   */
  wasmFile?: string;
}

const LANGUAGE_CONFIG: Record<string, LangConfig> = {
  typescript: { package: "tree-sitter-typescript", moduleExport: "typescript" },
  tsx: { package: "tree-sitter-typescript", moduleExport: "tsx" },
  javascript: { package: "tree-sitter-javascript" },
  python: { package: "tree-sitter-python" },
  go: { package: "tree-sitter-go" },
  rust: { package: "tree-sitter-rust" },
  clojure: { package: "@yogthos/tree-sitter-clojure", wasm: true, wasmFile: "tree-sitter-clojure.wasm" },
  // Scheme and Common Lisp ship as vendored WASM — see grammars/README.md for
  // provenance and why neither uses the native bindings. Racket reuses the
  // Scheme grammar but keeps its own language id so `.rkt` files report as
  // racket in the map projection.
  scheme: { wasm: true, wasmFile: "grammars/tree-sitter-scheme.wasm" },
  racket: { wasm: true, wasmFile: "grammars/tree-sitter-scheme.wasm" },
  commonlisp: { wasm: true, wasmFile: "grammars/tree-sitter-commonlisp.wasm" },
};

const EXT_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".rs": "rust",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".scm": "scheme",
  ".ss": "scheme",
  ".sld": "scheme",
  ".sls": "scheme",
  ".sps": "scheme",
  ".rkt": "racket",
  ".lisp": "commonlisp",
  ".lsp": "commonlisp",
  ".cl": "commonlisp",
  ".asd": "commonlisp",
};

function getNativeParser(): any {
  if (!NativeParser) {
    NativeParser = require("tree-sitter");
  }
  return NativeParser;
}

function getNativeParserInstance(): any {
  if (!nativeParserInstance) {
    const ParserClass = getNativeParser();
    nativeParserInstance = new ParserClass();
  }
  return nativeParserInstance;
}

async function initWasm(): Promise<void> {
  if (!WasmParserClass) {
    const mod = require("web-tree-sitter");
    WasmLanguageClass = mod.Language;
    await mod.Parser.init();
    WasmParserClass = mod.Parser;
  }
}

function getLangConfig(language: string): LangConfig | null {
  const builtin = LANGUAGE_CONFIG[language];
  if (builtin) return builtin;

  const adapter = getAdapter(language);
  if (!adapter) return null;
  const g = adapter.grammar;
  return g.wasm
    ? { package: g.package, wasm: true, wasmFile: g.wasmFile }
    : { package: g.package, moduleExport: g.moduleExport };
}

function loadLanguageSync(language: string): { lang: any; wasm: boolean } | null {
  const cached = languageCache.get(language);
  if (cached && !cached.wasm) return cached;

  const config = getLangConfig(language);
  if (!config || config.wasm || !config.package) return null;

  try {
    let mod = require(config.package);
    if (config.moduleExport) {
      mod = mod[config.moduleExport];
    }
    const entry = { lang: mod, wasm: false };
    languageCache.set(language, entry);
    return entry;
  } catch {
    return null;
  }
}

async function loadLanguageAsync(language: string): Promise<{ lang: any; wasm: boolean } | null> {
  const cached = languageCache.get(language);
  if (cached) return cached;

  const config = getLangConfig(language);
  if (!config) return null;

  try {
    if (config.wasm && config.wasmFile) {
      await initWasm();
      // Vendored grammars resolve against the chiasmus package root; grammars
      // shipped by an npm package resolve inside that package.
      const baseDir = config.package
        ? dirname(require.resolve(`${config.package}/package.json`))
        : PACKAGE_ROOT;
      const wasmPath = resolve(baseDir, config.wasmFile);
      // Languages can share one grammar file (racket reuses scheme's), so
      // cache the compiled Language by path to avoid a second compile.
      let lang = wasmLanguageByPath.get(wasmPath);
      if (!lang) {
        lang = await WasmLanguageClass.load(wasmPath);
        wasmLanguageByPath.set(wasmPath, lang);
      }
      const entry = { lang, wasm: true };
      languageCache.set(language, entry);
      return entry;
    }
    if (!config.package) return null;
    let mod = require(config.package);
    if (config.moduleExport) {
      mod = mod[config.moduleExport];
    }
    const entry = { lang: mod, wasm: false };
    languageCache.set(language, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Get the tree-sitter language name for a file path */
export function getLanguageForFile(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  // Check built-in first, then registered adapters
  return EXT_MAP[ext] ?? getAdapterForExt(ext)?.language ?? null;
}

/** Get all supported file extensions */
export function getSupportedExtensions(): string[] {
  return [...Object.keys(EXT_MAP), ...getAdapterExtensions()];
}

/** Parse source code (sync — CJS grammars only). Returns null for WASM grammars. */
export function parseSource(content: string, filePath: string): any | null {
  const language = getLanguageForFile(filePath);
  if (!language) return null;

  const loaded = loadLanguageSync(language);
  if (!loaded) return null;

  const parser = getNativeParserInstance();
  parser.setLanguage(loaded.lang);
  return parser.parse(content);
}

/** Get or create the cached WASM parser instance. */
function getWasmParserInstance(): any {
  if (!wasmParserInstance) {
    wasmParserInstance = new WasmParserClass();
  }
  return wasmParserInstance;
}

/** Async parse — handles both native CJS and WASM grammars. */
export async function parseSourceAsync(content: string, filePath: string): Promise<any | null> {
  const language = getLanguageForFile(filePath);
  if (!language) return null;

  const loaded = await loadLanguageAsync(language);
  if (!loaded) return null;

  if (loaded.wasm) {
    await initWasm();
    const parser = getWasmParserInstance();
    parser.setLanguage(loaded.lang);
    return parser.parse(content);
  }

  const parser = getNativeParserInstance();
  parser.setLanguage(loaded.lang);
  return parser.parse(content);
}
