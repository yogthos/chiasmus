import { createRequire } from "node:module";
import { extname, resolve, dirname } from "node:path";

const require = createRequire(import.meta.url);

// Lazy-loaded tree-sitter parsers (native for CJS grammars, WASM for Clojure)
let NativeParser: any = null;
let WasmParserClass: any = null;
let WasmLanguageClass: any = null;
const languageCache = new Map<string, { lang: any; wasm: boolean }>();

interface LangConfig {
  package: string;
  moduleExport?: string;
  wasm?: boolean;
  wasmFile?: string;
}

const LANGUAGE_CONFIG: Record<string, LangConfig> = {
  typescript: { package: "tree-sitter-typescript", moduleExport: "typescript" },
  tsx: { package: "tree-sitter-typescript", moduleExport: "tsx" },
  javascript: { package: "tree-sitter-javascript" },
  python: { package: "tree-sitter-python" },
  go: { package: "tree-sitter-go" },
  clojure: { package: "@yogthos/tree-sitter-clojure", wasm: true, wasmFile: "tree-sitter-clojure.wasm" },
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
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
};

function getNativeParser(): any {
  if (!NativeParser) {
    NativeParser = require("tree-sitter");
  }
  return NativeParser;
}

async function initWasm(): Promise<void> {
  if (!WasmParserClass) {
    const mod = require("web-tree-sitter");
    WasmLanguageClass = mod.Language;
    await mod.Parser.init();
    WasmParserClass = mod.Parser;
  }
}

function loadLanguageSync(language: string): { lang: any; wasm: boolean } | null {
  const cached = languageCache.get(language);
  if (cached && !cached.wasm) return cached;

  const config = LANGUAGE_CONFIG[language];
  if (!config || config.wasm) return null;

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

  const config = LANGUAGE_CONFIG[language];
  if (!config) return null;

  try {
    if (config.wasm && config.wasmFile) {
      await initWasm();
      const pkgPath = require.resolve(`${config.package}/package.json`);
      const pkgDir = dirname(pkgPath);
      const wasmPath = resolve(pkgDir, config.wasmFile);
      const lang = await WasmLanguageClass.load(wasmPath);
      const entry = { lang, wasm: true };
      languageCache.set(language, entry);
      return entry;
    }
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
  return EXT_MAP[ext] ?? null;
}

/** Get all supported file extensions */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_MAP);
}

/** Parse source code (sync — CJS grammars only). Returns null for WASM grammars. */
export function parseSource(content: string, filePath: string): any | null {
  const language = getLanguageForFile(filePath);
  if (!language) return null;

  const loaded = loadLanguageSync(language);
  if (!loaded) return null;

  const ParserClass = getNativeParser();
  const parser = new ParserClass();
  parser.setLanguage(loaded.lang);
  return parser.parse(content);
}

/** Async parse — handles both native CJS and WASM grammars. */
export async function parseSourceAsync(content: string, filePath: string): Promise<any | null> {
  const language = getLanguageForFile(filePath);
  if (!language) return null;

  const loaded = await loadLanguageAsync(language);
  if (!loaded) return null;

  if (loaded.wasm) {
    await initWasm();
    const parser = new WasmParserClass();
    parser.setLanguage(loaded.lang);
    return parser.parse(content);
  }

  const ParserClass = getNativeParser();
  const parser = new ParserClass();
  parser.setLanguage(loaded.lang);
  return parser.parse(content);
}
