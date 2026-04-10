/**
 * Minimal BM25 search for template retrieval.
 * Each "document" is a template's concatenated searchable text.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "not", "no", "nor", "so", "if", "then", "than", "that", "this",
  "these", "those", "it", "its",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

interface DocEntry {
  index: number;
  tokens: string[];
  length: number;
}

export interface BM25Index {
  docs: DocEntry[];
  idf: Map<string, number>;
  avgLength: number;
}

export function buildIndex(texts: string[]): BM25Index {
  const docs: DocEntry[] = texts.map((text, index) => {
    const tokens = tokenize(text);
    return { index, tokens, length: tokens.length };
  });

  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);

  // Compute IDF for each term
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(doc.tokens);
    for (const term of seen) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const N = docs.length;
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  return { docs, idf, avgLength };
}

/** Incrementally add a document to an existing index (avoids full rebuild) */
export function addToIndex(index: BM25Index, text: string): void {
  const tokens = tokenize(text);
  const doc: DocEntry = { index: index.docs.length, tokens, length: tokens.length };

  // Update avgLength incrementally
  const totalLength = index.avgLength * index.docs.length + doc.length;
  index.docs.push(doc);
  index.avgLength = totalLength / index.docs.length;

  // Update IDF: recompute for affected terms
  const N = index.docs.length;
  const seen = new Set(doc.tokens);

  // First, increment doc frequency for new terms
  for (const term of seen) {
    // We need to count all docs containing this term — the existing IDF may be stale
    // For incremental add, just count the new doc's contribution
    let df = 0;
    for (const d of index.docs) {
      if (new Set(d.tokens).has(term)) df++;
    }
    index.idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
}

/** Remove a document from the index by its position. Returns true if removed. */
export function removeFromIndex(index: BM25Index, docIndex: number): boolean {
  if (docIndex < 0 || docIndex >= index.docs.length) return false;

  // Recompute from remaining docs
  const remaining = index.docs.filter((_, i) => i !== docIndex);
  const texts = remaining.map((d) => d.tokens.join(" "));
  const rebuilt = buildIndex(texts);

  // Mutate in place
  index.docs.length = 0;
  index.docs.push(...rebuilt.docs);
  index.idf.clear();
  for (const [k, v] of rebuilt.idf) {
    index.idf.set(k, v);
  }
  index.avgLength = rebuilt.avgLength;
  return true;
}

export function search(
  index: BM25Index,
  query: string,
  limit = 10,
  k1 = 1.2,
  b = 0.75,
): Array<{ docIndex: number; score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scores: Array<{ docIndex: number; score: number }> = [];

  for (const doc of index.docs) {
    let score = 0;

    // Count term frequencies in this doc
    const tf = new Map<string, number>();
    for (const token of doc.tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    for (const term of queryTokens) {
      const termIdf = index.idf.get(term);
      if (!termIdf) continue;

      const termTf = tf.get(term) ?? 0;
      if (termTf === 0) continue;

      const numerator = termTf * (k1 + 1);
      const denominator = termTf + k1 * (1 - b + b * (doc.length / index.avgLength));
      score += termIdf * (numerator / denominator);
    }

    if (score > 0) {
      scores.push({ docIndex: doc.index, score });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, limit);
}
