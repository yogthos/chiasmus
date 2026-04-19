// Search engine: build an embedding corpus from a CodeGraph + source,
// run a semantic query against it via a pluggable EmbeddingAdapter,
// return top-K hits. Linear-scan vector store; fine for repos well
// under ~10k callable defines.

import type { CodeGraph, DefinesFact } from "../graph/types.js";
import type { EmbeddingAdapter } from "../llm/types.js";
import { VectorStore } from "./vector-store.js";
import { EmbeddingCache } from "./embedding-cache.js";

export interface SearchCorpusEntry {
  /** Stable id: `{file}#{name}#{line}` — deduplicates cross-class name clashes. */
  id: string;
  /** Short symbol name — function or method. */
  name: string;
  file: string;
  /** 1-based line number where the define begins. */
  line: number;
  /** Raw signature text, or the name when unavailable. */
  signature?: string;
  /** Leading JSDoc/docstring/block comment associated with the file. */
  leadingDoc?: string;
  /** Concatenated text used for embedding. */
  text: string;
}

export interface SearchHit {
  id: string;
  name: string;
  file: string;
  line: number;
  signature?: string;
  leadingDoc?: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

export interface RunSearchOptions {
  query: string;
  corpus: SearchCorpusEntry[];
  adapter: EmbeddingAdapter;
  topK: number;
  /** Optional cache to avoid re-embedding unchanged corpus entries. */
  cache?: EmbeddingCache;
}

/**
 * Turn a CodeGraph into an embedding-ready corpus. One entry per
 * callable define (function or method). Skips defines whose host file
 * isn't present in `files` (no text to extract a body snippet from).
 */
export function buildSearchCorpus(
  graph: CodeGraph,
  files: Map<string, string>,
): SearchCorpusEntry[] {
  const out: SearchCorpusEntry[] = [];
  // Index FileNode.fileDoc lookups (cheap; small map).
  const fileDoc = new Map<string, string>();
  for (const f of graph.files ?? []) {
    if (f.fileDoc) fileDoc.set(f.path, f.fileDoc);
  }
  for (const d of graph.defines) {
    if (d.kind !== "function" && d.kind !== "method") continue;
    const content = files.get(d.file);
    if (!content) continue;
    const snippet = snippetAround(content, d.line);
    const parts: string[] = [d.name];
    if (d.signature) parts.push(d.signature);
    const doc = fileDoc.get(d.file);
    if (doc) parts.push(doc);
    parts.push(snippet);
    const text = parts.join("\n").slice(0, 2000);
    out.push({
      id: makeEntryId(d),
      name: d.name,
      file: d.file,
      line: d.line,
      signature: d.signature,
      leadingDoc: doc,
      text,
    });
  }
  return out;
}

export async function runSearch(opts: RunSearchOptions): Promise<SearchHit[]> {
  const { query, corpus, adapter, topK, cache } = opts;
  if (corpus.length === 0) return [];

  const dim = adapter.dimension();
  const store = new VectorStore({ dimension: dim });

  const toEmbed: string[] = [];
  const toEmbedIdx: number[] = [];
  const cachedVecs = new Map<number, number[]>();

  for (let i = 0; i < corpus.length; i++) {
    const text = corpus[i].text;
    const hit = cache?.get(text) ?? null;
    if (hit && hit.length === dim) {
      cachedVecs.set(i, hit);
    } else {
      toEmbed.push(text);
      toEmbedIdx.push(i);
    }
  }

  if (toEmbed.length > 0) {
    const fresh = await adapter.embed(toEmbed);
    for (let j = 0; j < fresh.length; j++) {
      const idx = toEmbedIdx[j];
      cachedVecs.set(idx, fresh[j]);
      cache?.put(toEmbed[j], fresh[j]);
    }
  }

  for (let i = 0; i < corpus.length; i++) {
    const v = cachedVecs.get(i);
    if (!v) continue;
    store.add({ id: corpus[i].id, vector: v });
  }

  const [queryVec] = await adapter.embed([query]);
  const hits = store.search(queryVec, topK);

  const byId = new Map<string, SearchCorpusEntry>();
  for (const e of corpus) byId.set(e.id, e);
  const out: SearchHit[] = [];
  for (const h of hits) {
    const e = byId.get(h.id);
    if (!e) continue;
    out.push({
      id: h.id,
      name: e.name,
      file: e.file,
      line: e.line,
      signature: e.signature,
      leadingDoc: e.leadingDoc,
      score: h.score,
    });
  }
  return out;
}

function makeEntryId(d: DefinesFact): string {
  return `${d.file}#${d.name}#${d.line}`;
}

const SNIPPET_LINES = 6;

function snippetAround(source: string, startLine: number): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, start + SNIPPET_LINES);
  return lines.slice(start, end).join("\n");
}
