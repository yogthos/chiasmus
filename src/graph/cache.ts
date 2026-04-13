/**
 * On-disk cache for extracted per-file CodeGraph fragments.
 *
 * Layout:
 *   <cacheDir>/<repoKey>/
 *     .lock                 proper-lockfile target (empty file)
 *     manifest.json         { schemaVersion, entries: {absPath: {hash, size, savedAt}} }
 *     files/<hash>.json     one serialized CodeGraph fragment per cached file
 *
 * - Writes are atomic via `.tmp` + `rename`.
 * - All manifest read-modify-write sequences are serialized by proper-lockfile
 *   on `.lock`. Readers (checkFileCache) tolerate a racing eviction by treating
 *   a missing file as a miss.
 * - LRU is tracked via file mtime: `utimes` bumps the cache entry on every
 *   hit. Eviction sorts oldest-first and removes until the per-repo byte
 *   budget is satisfied.
 * - Schema version mismatch invalidates every entry (returns an empty manifest
 *   from readManifest).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { CodeGraph } from "./types.js";

export const CACHE_SCHEMA_VERSION = "1";

const DEFAULT_MAX_BYTES_PER_REPO = 64 * 1024 * 1024; // 64 MB

export interface CacheOptions {
  /** Root cache directory. Defaults to ~/.cache/chiasmus or $CHIASMUS_CACHE_DIR. */
  cacheDir?: string;
  /** Identifier for a specific repository/project. Defaults to "default". */
  repoKey?: string;
  /** Per-repo byte budget. Defaults to 64 MB or $CHIASMUS_CACHE_MAX_PER_REPO. */
  maxBytesPerRepo?: number;
}

export interface CachePaths {
  cacheDir: string;
  repoDir: string;
  filesDir: string;
  manifestPath: string;
  lockPath: string;
}

interface ManifestEntry {
  hash: string;
  size: number;
  savedAt: number;
}

interface Manifest {
  schemaVersion: string;
  entries: Record<string, ManifestEntry>;
}

function defaultCacheDir(): string {
  if (process.env.CHIASMUS_CACHE_DIR) return process.env.CHIASMUS_CACHE_DIR;
  return join(homedir(), ".cache", "chiasmus");
}

export function resolveCachePaths(opts: CacheOptions = {}): CachePaths {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const repoKey = opts.repoKey ?? "default";
  const repoDir = join(cacheDir, repoKey);
  return {
    cacheDir,
    repoDir,
    filesDir: join(repoDir, "files"),
    manifestPath: join(repoDir, "manifest.json"),
    lockPath: join(repoDir, ".lock"),
  };
}

/**
 * Per-file content hash. SHA256 of content || 0x00 || absPath. Matches
 * graphify `cache.py:20-33` — the path suffix prevents two distinct files
 * with identical content from colliding.
 */
export function fileHash(content: string, absPath: string): string {
  const h = createHash("sha256");
  h.update(content, "utf-8");
  h.update(Buffer.from([0]));
  h.update(absPath, "utf-8");
  return h.digest("hex");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureLockFile(paths: CachePaths): Promise<void> {
  await ensureDir(paths.repoDir);
  try {
    const fd = await fs.open(paths.lockPath, "a");
    await fd.close();
  } catch {
    // Non-fatal — lock acquisition will surface the real error.
  }
}

async function readManifest(paths: CachePaths): Promise<Manifest> {
  try {
    const raw = await fs.readFile(paths.manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      // Schema drift invalidates every entry — return an empty manifest so
      // the next save writes the current schema version.
      return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
  }
}

async function writeManifest(paths: CachePaths, manifest: Manifest): Promise<void> {
  const tmp = paths.manifestPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(manifest));
  await fs.rename(tmp, paths.manifestPath);
}

async function withRepoLock<T>(paths: CachePaths, fn: () => Promise<T>): Promise<T> {
  await ensureLockFile(paths);
  const release = await lockfile.lock(paths.lockPath, {
    retries: { retries: 100, minTimeout: 5, maxTimeout: 100, factor: 1.3 },
    stale: 5_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function checkFileCache(
  files: Array<{ path: string; content: string }>,
  opts: CacheOptions = {},
): Promise<{
  hits: Array<{ path: string; graph: CodeGraph }>;
  misses: Array<{ path: string; content: string }>;
}> {
  const paths = resolveCachePaths(opts);
  const manifest = await readManifest(paths);

  const hits: Array<{ path: string; graph: CodeGraph }> = [];
  const misses: Array<{ path: string; content: string }> = [];
  const now = new Date();

  for (const f of files) {
    const h = fileHash(f.content, f.path);
    const entry = manifest.entries[f.path];
    if (entry && entry.hash === h) {
      const cachePath = join(paths.filesDir, `${h}.json`);
      try {
        const raw = await fs.readFile(cachePath, "utf-8");
        const graph = JSON.parse(raw) as CodeGraph;
        // Bump mtime for LRU ordering. Best-effort — a concurrent eviction
        // racing us is acceptable since the next read will miss and repopulate.
        try {
          await fs.utimes(cachePath, now, now);
        } catch {}
        hits.push({ path: f.path, graph });
        continue;
      } catch {
        // File missing or corrupt — fall through to miss.
      }
    }
    misses.push({ path: f.path, content: f.content });
  }

  return { hits, misses };
}

export async function saveFileCache(
  items: Array<{ path: string; content: string; graph: CodeGraph }>,
  opts: CacheOptions = {},
): Promise<void> {
  if (items.length === 0) return;
  const paths = resolveCachePaths(opts);
  await ensureDir(paths.filesDir);

  await withRepoLock(paths, async () => {
    const manifest = await readManifest(paths);
    const now = Date.now();

    for (const item of items) {
      const h = fileHash(item.content, item.path);
      const cachePath = join(paths.filesDir, `${h}.json`);
      const tmp = cachePath + ".tmp";
      const serialized = JSON.stringify(item.graph);
      await fs.writeFile(tmp, serialized);
      await fs.rename(tmp, cachePath);
      manifest.entries[item.path] = {
        hash: h,
        size: Buffer.byteLength(serialized, "utf-8"),
        savedAt: now,
      };
    }

    await writeManifest(paths, manifest);
  });

  await evictLRU(opts);
}

/**
 * Enforce the per-repo byte budget. Scans files/ directly (not the manifest)
 * so orphaned entries left by a crash also count toward the budget. Sorts by
 * mtime ascending — graphify has no equivalent; this is our addition.
 *
 * When evictions happen, the manifest is rewritten to drop the removed
 * entries so subsequent reads don't claim hits for now-missing files.
 */
export async function evictLRU(opts: CacheOptions = {}): Promise<void> {
  const paths = resolveCachePaths(opts);
  const budget = opts.maxBytesPerRepo ?? DEFAULT_MAX_BYTES_PER_REPO;

  await withRepoLock(paths, async () => {
    let names: string[];
    try {
      names = await fs.readdir(paths.filesDir);
    } catch {
      return; // No files dir yet.
    }

    const entries: Array<{ name: string; size: number; mtime: number; path: string }> = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue; // Skip .tmp and anything else.
      const p = join(paths.filesDir, n);
      try {
        const s = await fs.stat(p);
        entries.push({ name: n, size: s.size, mtime: s.mtimeMs, path: p });
      } catch {
        // File vanished between readdir and stat — ignore.
      }
    }

    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= budget) return;

    entries.sort((a, b) => a.mtime - b.mtime); // oldest first

    const manifest = await readManifest(paths);
    const hashToFilePath = new Map<string, string>();
    for (const [filePath, e] of Object.entries(manifest.entries)) {
      hashToFilePath.set(e.hash, filePath);
    }

    for (const e of entries) {
      if (total <= budget) break;
      try {
        await fs.unlink(e.path);
        total -= e.size;
        const hash = e.name.replace(/\.json$/, "");
        const filePath = hashToFilePath.get(hash);
        if (filePath) delete manifest.entries[filePath];
      } catch {
        // Concurrent removal — skip.
      }
    }

    await writeManifest(paths, manifest);
  });
}

export async function clearRepoCache(opts: CacheOptions = {}): Promise<void> {
  const paths = resolveCachePaths(opts);
  try {
    await fs.rm(paths.repoDir, { recursive: true, force: true });
  } catch {
    // Already gone — nothing to do.
  }
}

// ── Snapshots ────────────────────────────────────────────────────────────
//
// A snapshot is a full serialized CodeGraph saved under a user-chosen name
// (usually a branch name or git SHA). Separate from the per-file cache —
// used by chiasmus_graph's `diff` analysis and chiasmus_review's PR-delta
// phase to compare two points in time.

function snapshotsDir(paths: CachePaths): string {
  return join(paths.repoDir, "snapshots");
}

function validateSnapshotName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error("Snapshot name cannot be empty");
  }
  // Reject anything that could escape the snapshots directory.
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
    throw new Error(`Invalid snapshot name: ${name}`);
  }
}

function snapshotPath(paths: CachePaths, name: string): string {
  validateSnapshotName(name);
  return join(snapshotsDir(paths), `${name}.json`);
}

export async function saveSnapshot(
  name: string,
  graph: CodeGraph,
  opts: CacheOptions = {},
): Promise<void> {
  validateSnapshotName(name);
  const paths = resolveCachePaths(opts);
  const dir = snapshotsDir(paths);
  await ensureDir(dir);
  const target = snapshotPath(paths, name);
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(graph));
  await fs.rename(tmp, target);
}

export async function loadSnapshot(
  name: string,
  opts: CacheOptions = {},
): Promise<CodeGraph | null> {
  validateSnapshotName(name);
  const paths = resolveCachePaths(opts);
  try {
    const raw = await fs.readFile(snapshotPath(paths, name), "utf-8");
    return JSON.parse(raw) as CodeGraph;
  } catch {
    return null;
  }
}

export async function listSnapshots(opts: CacheOptions = {}): Promise<string[]> {
  const paths = resolveCachePaths(opts);
  try {
    const entries = await fs.readdir(snapshotsDir(paths));
    return entries.filter((e) => e.endsWith(".json")).map((e) => e.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export async function deleteSnapshot(
  name: string,
  opts: CacheOptions = {},
): Promise<void> {
  validateSnapshotName(name);
  const paths = resolveCachePaths(opts);
  try {
    await fs.unlink(snapshotPath(paths, name));
  } catch {
    // Already gone — nothing to do.
  }
}
