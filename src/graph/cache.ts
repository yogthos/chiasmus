/**
 * On-disk cache for per-file CodeGraph extraction results.
 *
 * Layout:
 *   <cacheDir>/<repoKey>/
 *     .lock                 proper-lockfile target
 *     .write-in-progress    present while a writer holds the lock (see withRepoLock)
 *     manifest.json         { schemaVersion, entries: {absPath: {hash, size, savedAt}} }
 *     files/<hash>.json     one serialized CodeGraph fragment per cached file
 *     snapshots/<name>.json full serialized graph at a point in time
 *
 * Every write goes through `withRepoLock`: manifest read-modify-writes, per-file
 * entries and snapshots, each written to a `.tmp` name and renamed into place.
 * Readers tolerate a racing eviction by treating a missing file as a miss.
 * LRU is tracked via file mtime: `utimes` bumps the entry on every hit, and
 * eviction sorts oldest-first.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { CodeGraph } from "./types.js";

// "3" introduced CodeGraph._typeInfo (per-file class fields + pending calls)
// and CallsFact.calleeQN for qualified-name call resolution; "2" caches
// would still work but produce no QN until files naturally re-extract, so
// invalidate eagerly so the benefit is uniform across the repo.
// "2" introduced FileNode.fileDoc/tokenEstimate/lineCount and
// DefinesFact.signature; "1" caches lack these fields and would render as
// partial maps until naturally invalidated by content change.
export const CACHE_SCHEMA_VERSION = "4";

const DEFAULT_MAX_BYTES_PER_REPO = 64 * 1024 * 1024; // 64 MB

export interface CacheOptions {
  /** Root cache directory. Defaults to $CHIASMUS_CACHE_DIR or ~/.cache/chiasmus. */
  cacheDir?: string;
  /** Identifier for a specific repository/project. Defaults to "default". */
  repoKey?: string;
  /**
   * Per-repo byte budget. Defaults to $CHIASMUS_CACHE_MAX_PER_REPO or 64 MB.
   */
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

function defaultMaxBytesPerRepo(): number {
  const env = process.env.CHIASMUS_CACHE_MAX_PER_REPO;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BYTES_PER_REPO;
}

/** Deterministic repoKey derived from a working directory — safe across sessions. */
export function defaultRepoKey(cwd: string = process.cwd()): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
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
 * Per-file content hash. The path suffix prevents two distinct files with
 * identical content from colliding.
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

// Memoize the one-time lockfile bootstrap per repoDir so `withRepoLock`
// doesn't pay an `open(..., "a")` + `close` on every acquisition.
// Bounded to prevent unbounded growth in long-running servers that touch
// many distinct repos — evict the oldest (insertion-order) entry when full.
const BOOTSTRAP_CAP = 256;
const bootstrapped = new Map<string, Promise<void>>();

async function ensureLockFile(paths: CachePaths): Promise<void> {
  const pending = bootstrapped.get(paths.repoDir);
  if (pending) {
    // Refresh LRU position: delete + re-insert moves to the newest slot.
    bootstrapped.delete(paths.repoDir);
    bootstrapped.set(paths.repoDir, pending);
    return pending;
  }
  const p = (async () => {
    await ensureDir(paths.repoDir);
    try {
      const fd = await fs.open(paths.lockPath, "a");
      await fd.close();
    } catch {
      // Lock acquisition will surface the real error if this genuinely failed.
    }
  })();
  if (bootstrapped.size >= BOOTSTRAP_CAP) {
    const oldest = bootstrapped.keys().next().value;
    if (oldest !== undefined) bootstrapped.delete(oldest);
  }
  bootstrapped.set(paths.repoDir, p);
  return p;
}

function emptyManifest(): Manifest {
  return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
}

async function readManifest(paths: CachePaths): Promise<Manifest> {
  return (await loadManifest(paths)) ?? emptyManifest();
}

/**
 * The manifest, or undefined when it exists but could not be read (EMFILE,
 * EACCES, EIO). Missing, unparseable or of another schema version, it is
 * empty: nothing it listed can be served.
 */
async function loadManifest(paths: CachePaths): Promise<Manifest | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.manifestPath, "utf-8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? emptyManifest() : undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Manifest;
    return parsed.schemaVersion === CACHE_SCHEMA_VERSION ? parsed : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

async function writeManifest(paths: CachePaths, manifest: Manifest): Promise<void> {
  const tmp = paths.manifestPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(manifest));
  await fs.rename(tmp, paths.manifestPath);
}

function writeMarkerPath(paths: CachePaths): string {
  return join(paths.repoDir, ".write-in-progress");
}

/**
 * Runs `fn` holding the repo lock, the only way anything in the cache is
 * written. A writer can die mid-write — the graph child is SIGKILLed on
 * cancellation, timeout and shutdown — leaving a half-written `.tmp`, or
 * per-file entries renamed into place that the manifest never listed (the
 * eviction fast path, which sums the manifest's sizes, would never count
 * them). So `fn` runs inside a write-in-progress marker, created before its
 * first write and removed after its last; finding the marker on taking the
 * lock means the previous holder died mid-write (or stalled past the 5 s
 * stale window and lost the lock — see AGENTS.md), and its leftovers are
 * reclaimed before `fn` runs. Since every `.tmp` writer holds the lock, none
 * of those files belongs to a live writer, barring that stalled holder. A failed `fn` leaves the marker,
 * so whatever it wrote is reclaimed the same way, and so does a reclaim that
 * could not finish (an unreadable manifest, a directory that could not be
 * listed, an entry that could not be removed).
 */
async function withRepoLock<T>(paths: CachePaths, fn: () => Promise<T>): Promise<T> {
  await ensureLockFile(paths);
  const release = await lockfile.lock(paths.lockPath, {
    retries: { retries: 100, minTimeout: 5, maxTimeout: 100, factor: 1.3 },
    stale: 5_000,
  });
  try {
    const abandoned = await markWriteInProgress(paths);
    const clean = !abandoned || (await reclaimAbandonedWrite(paths));
    const result = await fn();
    // Left in place, the marker only costs the next writer a directory scan.
    if (clean) await fs.unlink(writeMarkerPath(paths)).catch(() => {});
    return result;
  } finally {
    await release();
  }
}

/** Create the write-in-progress marker; true when it was already there. */
async function markWriteInProgress(paths: CachePaths): Promise<boolean> {
  try {
    await (await fs.open(writeMarkerPath(paths), "wx")).close();
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return true;
    throw e;
  }
}

/**
 * Remove what a writer that died holding the lock left behind: temp files
 * (per-file entries, the manifest, snapshots) and per-file entries the
 * manifest does not list. Called under the lock, only after such a death.
 * False when it could not finish, so the marker stays and the next writer
 * tries again: the manifest exists but could not be read (which entries it
 * lists is then unknown, so only the temp files go), or a directory could
 * not be listed, or an entry could not be removed. (Entries the manifest
 * lists but whose file is gone, which a writer killed mid-eviction leaves,
 * are dropped by the eviction scan.)
 */
async function reclaimAbandonedWrite(paths: CachePaths): Promise<boolean> {
  const snapshotsClean = await removeEntries(snapshotsDir(paths), (n) => n.endsWith(".tmp"));
  const manifestTmpClean = await fs.rm(paths.manifestPath + ".tmp", { force: true }).then(() => true, () => false);
  const manifest = await loadManifest(paths);
  if (!manifest) {
    await removeEntries(paths.filesDir, (n) => n.endsWith(".tmp"));
    return false;
  }
  const listed = new Set(Object.values(manifest.entries).map((e) => `${e.hash}.json`));
  const filesClean = await removeEntries(
    paths.filesDir,
    (n) => n.endsWith(".tmp") || (n.endsWith(".json") && !listed.has(n)),
  );
  return snapshotsClean && manifestTmpClean && filesClean;
}

/**
 * Remove the entries of `dir` that `match`. False when they could not all be
 * listed and removed; a missing directory has nothing to remove.
 */
async function removeEntries(dir: string, match: (name: string) => boolean): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  const removed = await Promise.allSettled(names.filter(match).map((n) => fs.rm(join(dir, n), { force: true })));
  return removed.every((r) => r.status === "fulfilled");
}

export async function checkFileCache(
  files: Array<{ path: string; content: string }>,
  opts: CacheOptions = {},
): Promise<{
  hits: Array<{ path: string; graph: CodeGraph }>;
  misses: Array<{ path: string; content: string }>;
}> {
  // Read path is intentionally unlocked — warm hits need to stay cheap.
  // Safety relies on two invariants:
  //   1. Every manifest write is `writeFile(.tmp) + rename` (POSIX-atomic;
  //      Windows ReplaceFile is too). Readers see either the old or new
  //      manifest, never a torn document.
  //   2. `readManifest` returns an empty manifest on any parse/read failure,
  //      which forces every file into the miss path. The subsequent
  //      `saveFileCache` rewrites the manifest correctly, so any transient
  //      corruption is self-healing — not a silent correctness failure.
  // Reading under the write lock would serialize every check behind saves
  // and roughly double warm-hit latency; the unlocked path stays safe.
  const paths = resolveCachePaths(opts);
  const manifest = await readManifest(paths);
  const now = new Date();

  const results = await Promise.all(
    files.map(async (f) => {
      const h = fileHash(f.content, f.path);
      const entry = manifest.entries[f.path];
      if (!entry || entry.hash !== h) {
        return { hit: false as const, path: f.path, content: f.content };
      }
      const cachePath = join(paths.filesDir, `${h}.json`);
      try {
        const raw = await fs.readFile(cachePath, "utf-8");
        const graph = JSON.parse(raw) as CodeGraph;
        // Best-effort mtime bump for LRU ordering.
        fs.utimes(cachePath, now, now).catch(() => {});
        return { hit: true as const, path: f.path, graph };
      } catch {
        return { hit: false as const, path: f.path, content: f.content };
      }
    }),
  );

  const hits: Array<{ path: string; graph: CodeGraph }> = [];
  const misses: Array<{ path: string; content: string }> = [];
  for (const r of results) {
    if (r.hit) hits.push({ path: r.path, graph: r.graph });
    else misses.push({ path: r.path, content: r.content });
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
  const budget = opts.maxBytesPerRepo ?? defaultMaxBytesPerRepo();

  await withRepoLock(paths, async () => {
    const manifest = await readManifest(paths);
    const now = Date.now();

    // Prepare serializations synchronously so the hot path's awaits are all I/O.
    // One entry per file, the last content winning: chiasmus_graph does not
    // dedupe its `files`, and two parallel writes of one entry share a temp
    // name, so the second rename would fail.
    const latest = [...new Map(items.map((item) => [item.path, item])).values()];
    const prepared = latest.map((item) => {
      const h = fileHash(item.content, item.path);
      const serialized = JSON.stringify(item.graph);
      return {
        path: item.path,
        hash: h,
        serialized,
        size: Buffer.byteLength(serialized, "utf-8"),
        cachePath: join(paths.filesDir, `${h}.json`),
      };
    });

    // Parallel atomic writes — dominated the cold-populate latency when
    // sequential (41 files × ~4 ms write+rename = ~165 ms observed).
    await Promise.all(prepared.map(async (p) => {
      const tmp = p.cachePath + ".tmp";
      await fs.writeFile(tmp, p.serialized);
      await fs.rename(tmp, p.cachePath);
    }));

    // A file whose content changed has a new entry name: its old entry is
    // listed nowhere once the manifest is written, and the eviction fast
    // path (the manifest's sizes) would never count it.
    const superseded: string[] = [];
    for (const p of prepared) {
      const old = manifest.entries[p.path];
      if (old && old.hash !== p.hash) superseded.push(join(paths.filesDir, `${old.hash}.json`));
      manifest.entries[p.path] = { hash: p.hash, size: p.size, savedAt: now };
    }

    await writeManifest(paths, manifest);
    // An unlocked reader still holding the old manifest gets a miss.
    await Promise.all(superseded.map((f) => fs.rm(f, { force: true })));
    await evictIfOverBudget(paths, manifest, budget);
  });
}

/**
 * Fast-path eviction inside the current lock, using the manifest's tracked
 * sizes to decide whether the disk scan is needed at all. The full O(N)
 * directory walk only runs when the manifest total is over budget.
 */
async function evictIfOverBudget(
  paths: CachePaths,
  manifest: Manifest,
  budget: number,
): Promise<void> {
  let manifestTotal = 0;
  for (const e of Object.values(manifest.entries)) manifestTotal += e.size;
  if (manifestTotal <= budget) return;

  // Over budget — scan disk to include any orphans the manifest does not list.
  let names: string[];
  try {
    names = await fs.readdir(paths.filesDir);
  } catch {
    return;
  }
  // Drop what the manifest lists but is gone (deleted from outside, or by a
  // writer killed in the loop below before it rewrote the manifest): its
  // size would keep the fast path over budget, and every save scanning.
  const present = new Set(names);
  let changed = false;
  for (const [filePath, e] of Object.entries(manifest.entries)) {
    if (present.has(`${e.hash}.json`)) continue;
    delete manifest.entries[filePath];
    changed = true;
  }
  const entries: Array<{ name: string; size: number; mtime: number; path: string }> = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = join(paths.filesDir, n);
    try {
      const s = await fs.stat(p);
      entries.push({ name: n, size: s.size, mtime: s.mtimeMs, path: p });
    } catch {}
  }

  let total = entries.reduce((a, e) => a + e.size, 0);
  if (total <= budget) {
    if (changed) await writeManifest(paths, manifest);
    return;
  }

  entries.sort((a, b) => a.mtime - b.mtime);
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
      changed = true;
    } catch {}
  }

  if (changed) await writeManifest(paths, manifest);
}

/**
 * Public eviction entry point. Prefer the in-save fast path; use this only
 * when invoking eviction independently of a save (e.g. to reclaim space
 * after a budget change).
 */
export async function evictLRU(opts: CacheOptions = {}): Promise<void> {
  const paths = resolveCachePaths(opts);
  const budget = opts.maxBytesPerRepo ?? defaultMaxBytesPerRepo();
  await withRepoLock(paths, async () => {
    const manifest = await readManifest(paths);
    await evictIfOverBudget(paths, manifest, budget);
  });
}

export async function clearRepoCache(opts: CacheOptions = {}): Promise<void> {
  const paths = resolveCachePaths(opts);
  try {
    await fs.rm(paths.repoDir, { recursive: true, force: true });
  } catch {}
  bootstrapped.delete(paths.repoDir);
}

// ── Snapshots ────────────────────────────────────────────────────────────

function snapshotsDir(paths: CachePaths): string {
  return join(paths.repoDir, "snapshots");
}

function snapshotPath(paths: CachePaths, name: string): string {
  if (!name) throw new Error("Snapshot name cannot be empty");
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
    throw new Error(`Invalid snapshot name: ${name}`);
  }
  return join(snapshotsDir(paths), `${name}.json`);
}

export async function saveSnapshot(
  name: string,
  graph: CodeGraph,
  opts: CacheOptions = {},
): Promise<void> {
  const paths = resolveCachePaths(opts);
  const target = snapshotPath(paths, name);
  const serialized = JSON.stringify(graph);
  await ensureDir(snapshotsDir(paths));
  // Under the repo lock like every cache write (see withRepoLock), so a
  // temp file left by a writer that died here is reclaimed by the next one.
  await withRepoLock(paths, async () => {
    const tmp = target + ".tmp";
    await fs.writeFile(tmp, serialized);
    await fs.rename(tmp, target);
  });
}

export async function loadSnapshot(
  name: string,
  opts: CacheOptions = {},
): Promise<CodeGraph | null> {
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
  const paths = resolveCachePaths(opts);
  try {
    await fs.unlink(snapshotPath(paths, name));
  } catch {}
}
