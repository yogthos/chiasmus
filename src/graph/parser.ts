import { createRequire } from "node:module";
import { extname } from "node:path";

const require = createRequire(import.meta.url);

// Lazy-loaded tree-sitter parser
let Parser: any = null;
const languageCache = new Map<string, any>();

const LANGUAGE_CONFIG: Record<string, { package: string; moduleExport?: string }> = {
  typescript: { package: "tree-sitter-typescript", moduleExport: "typescript" },
  tsx: { package: "tree-sitter-typescript", moduleExport: "tsx" },
  javascript: { package: "tree-sitter-javascript" },
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
};

function getParser(): any {
  if (!Parser) {
    Parser = require("tree-sitter");
  }
  return Parser;
}

function loadLanguage(language: string): any {
  const cached = languageCache.get(language);
  if (cached) return cached;

  const config = LANGUAGE_CONFIG[language];
  if (!config) return null;

  try {
    let mod = require(config.package);
    if (config.moduleExport) {
      mod = mod[config.moduleExport];
    }
    languageCache.set(language, mod);
    return mod;
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

/** Parse source code into a tree-sitter tree. Returns null if language unsupported. */
export function parseSource(content: string, filePath: string): any | null {
  const language = getLanguageForFile(filePath);
  if (!language) return null;

  const lang = loadLanguage(language);
  if (!lang) return null;

  const ParserClass = getParser();
  const parser = new ParserClass();
  parser.setLanguage(lang);
  return parser.parse(content);
}
