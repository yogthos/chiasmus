import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultRepoKey, resolveCachePaths } from "../../src/graph/cache.js";
import { handleGraph } from "../../src/graph/tool-handlers.js";
import { GraphChildPool, childEntryFor } from "../../src/graph/child-pool.js";

const HOOK = fileURLToPath(new URL("./fixtures/pause-cache-write.mjs", import.meta.url));

function text(r: { content: unknown }): string {
  return (r.content as Array<{ text: string }>)[0].text;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function isJson(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]);
}

/** A pool whose real graph child preloads the pause-cache-write hook. */
function hookedPool(): GraphChildPool {
  const loaders = childEntryFor(new URL("../../src/graph/child-pool.ts", import.meta.url).href, process.execArgv);
  return new GraphChildPool({ execArgv: [...loaders.execArgv, "--import", pathToFileURL(HOOK).href] });
}

let kills = 0;

/**
 * Run `args` in `pool`'s child, pause the first write to a path containing
 * `match`, kill the child there through the pool's cancellation path, and
 * return the path whose write was cut off. The pause marker goes in `dir`.
 */
async function killMidWrite(
  pool: GraphChildPool,
  dir: string,
  match: string,
  args: Record<string, unknown>,
): Promise<string> {
  const marker = join(dir, `paused-${++kills}`);
  process.env.CHIASMUS_TEST_PAUSE_WRITE = match;
  process.env.CHIASMUS_TEST_PAUSE_MARKER = marker;
  try {
    const ac = new AbortController();
    const job = pool.run({ tool: "chiasmus_graph", args, signal: ac.signal });
    await until(() => existsSync(marker), 20_000);
    const pid = pool.pid!;
    ac.abort();
    expect(JSON.parse(text(await job)).error).toBe("chiasmus_graph was cancelled by the client");
    await until(() => !alive(pid), 10_000);
    return readFileSync(marker, "utf8");
  } finally {
    delete process.env.CHIASMUS_TEST_PAUSE_WRITE;
    delete process.env.CHIASMUS_TEST_PAUSE_MARKER;
  }
}

/**
 * Back-date a killed child's lock by a minute, past proper-lockfile's 5 s
 * stale threshold, as if those 5 s had gone by: the next save takes the lock
 * over at once. Only the first case below waits the real 5 s.
 */
async function ageLock(lockDir: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await utimes(lockDir, past, past);
}

/**
 * The pool stops a graph job by SIGKILLing its child, which may be in the
 * middle of writing the per-file cache, the manifest or a snapshot, and may
 * hold the cache lock. None of that may break a later run: every cache file
 * is written to a temp name and renamed into place, readers never look at
 * temp names, and the lock goes stale. Each case pauses the real child halfway
 * through one write, kills it through the pool's cancellation path, and runs
 * the same job again. The first case waits for the dead child's lock to go
 * stale; the other two age it first.
 */
describe("killing the graph child mid cache write", () => {
  let root: string;
  let files: string[];
  let pool: GraphChildPool;
  let repoDir: string;
  let lockDir: string;
  let expected: string;
  let prevCacheDir: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-cache-kill-"));
    prevCacheDir = process.env.CHIASMUS_CACHE_DIR;
    process.env.CHIASMUS_CACHE_DIR = join(root, "cache");
    const paths = resolveCachePaths({ cacheDir: join(root, "cache"), repoKey: defaultRepoKey() });
    repoDir = paths.repoDir;
    lockDir = `${paths.lockPath}.lock`;
    files = [];
    for (let f = 0; f < 30; f++) {
      const p = join(root, `m${f}.ts`);
      await writeFile(p, `export function f${f}(a: number) { return f${(f + 1) % 30}(a) + g${f}(a); }\nfunction g${f}(a: number) { return a; }\n`);
      files.push(p);
    }
    expected = text(await handleGraph({ files, analysis: "facts" }));
    pool = hookedPool();
  });

  afterAll(async () => {
    try {
      await pool.close();
    } finally {
      if (prevCacheDir === undefined) delete process.env.CHIASMUS_CACHE_DIR;
      else process.env.CHIASMUS_CACHE_DIR = prevCacheDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  /** What a reader could ever see: every non-temp cache file parses. */
  function expectNoTornCacheFile(): void {
    for (const p of filesUnder(repoDir)) {
      if (p.endsWith(".json")) expect(isJson(p), p).toBe(true);
    }
  }

  /** Facts as a set: a partly cached run lists the re-extracted files last. */
  function factSet(out: string): string[] {
    return (JSON.parse(out).result as string).split("\n").sort();
  }

  /**
   * The same cached job again, in a fresh child: the same facts, the dead
   * child's lock taken over, and a cache that then serves the whole job
   * byte-identically to a cold run.
   */
  async function expectCleanRerun(extra: Record<string, unknown> = {}): Promise<void> {
    const args = { files, analysis: "facts", cache: true };
    const t0 = performance.now();
    const rerun = text(await pool.run({ tool: "chiasmus_graph", args: { ...args, ...extra } }));
    // proper-lockfile treats a lock as stale 5 s after its holder last
    // refreshed it, so the rerun waits up to 5 s (none once the lock is
    // aged), plus a fresh child's start. A lock that never went stale would
    // fail the save once the retries run out (about 9 s) and the rerun would
    // return an error, not facts; the bound leaves room for a loaded host.
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(factSet(rerun)).toEqual(factSet(expected));
    expect(existsSync(lockDir)).toBe(false);
    // The rerun's save found the dead write unfinished and removed its temp file.
    expect(filesUnder(repoDir).filter((p) => p.endsWith(".tmp"))).toEqual([]);
    expectNoTornCacheFile();
    expect(text(await pool.run({ tool: "chiasmus_graph", args }))).toBe(expected);
  }

  it("while writing per-file entries, holding the lock", async () => {
    const tmp = await killMidWrite(pool, root, `${sep}files${sep}`, { files, analysis: "facts", cache: true });
    expect(tmp.endsWith(".json.tmp")).toBe(true);
    expect(isJson(tmp)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expectNoTornCacheFile();
    await expectCleanRerun();
  }, 60_000);

  it("while writing the manifest, holding the lock", async () => {
    // Change one file so the save has something to write.
    await writeFile(files[0], `${readFileSync(files[0], "utf8")}export function extra() {}\n`);
    expected = text(await handleGraph({ files, analysis: "facts" }));
    const tmp = await killMidWrite(pool, root, "manifest.json.tmp", { files, analysis: "facts", cache: true });
    expect(isJson(tmp)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expect(isJson(join(repoDir, "manifest.json"))).toBe(true);
    expectNoTornCacheFile();
    await ageLock(lockDir);
    await expectCleanRerun();
  }, 60_000);

  it("while writing a snapshot", async () => {
    const tmp = await killMidWrite(pool, root, `${sep}snapshots${sep}`, { files, analysis: "facts", cache: true, save_snapshot: "base" });
    expect(isJson(tmp)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expectNoTornCacheFile();
    // The snapshot was never completed, so it does not exist (rather than
    // being torn)... (Every file is a cache hit: no write, no lock.)
    const diff = JSON.parse(text(await pool.run({
      tool: "chiasmus_graph", args: { files, analysis: "diff", against: "base", cache: true },
    })));
    expect(diff.result.error).toBe("Snapshot 'base' not found. Save one first via saveSnapshot.");
    // ...and saving it again works.
    await ageLock(lockDir);
    await expectCleanRerun({ save_snapshot: "base" });
    const again = JSON.parse(text(await pool.run({
      tool: "chiasmus_graph", args: { files, analysis: "diff", against: "base", cache: true },
    })));
    expect(again.result.error).toBeUndefined();
  }, 60_000);
});

/**
 * What a killed write leaves must not wait for the same input to come back:
 * a half-written temp file, or per-file entries renamed into place before the
 * manifest listing them was written, which the eviction fast path (manifest
 * sizes only) never counts. Each case kills the child in one kind of write,
 * in a cache of its own under a 1 KiB budget, then caches a different file:
 * that save takes over the dead child's lock and must leave nothing of the
 * dead write behind.
 */
describe("caching a different file after a killed cache write", () => {
  const BUDGET = 1024;
  let root: string;
  let pool: GraphChildPool;
  let input: string[];
  let other: string;
  let otherFacts: string;
  let repoDir: string;
  let lockDir: string;
  let caches = 0;
  const prevEnv = {
    CHIASMUS_CACHE_DIR: process.env.CHIASMUS_CACHE_DIR,
    CHIASMUS_CACHE_MAX_PER_REPO: process.env.CHIASMUS_CACHE_MAX_PER_REPO,
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-cache-reclaim-"));
    process.env.CHIASMUS_CACHE_MAX_PER_REPO = String(BUDGET);
    // The first file's per-file entry (about 55 KB) is the one whose write
    // is paused; the two small ones are written alongside it.
    input = [join(root, "big.ts"), join(root, "a.ts"), join(root, "b.ts")];
    await writeFile(input[0], Array.from({ length: 500 }, (_, i) => `export function f${i}() { return ${i}; }`).join("\n"));
    await writeFile(input[1], "export function a() { return b(); }\n");
    await writeFile(input[2], "export function b() { return 1; }\n");
    other = join(root, "other.ts");
    await writeFile(other, "export function other() { return 1; }\n");
    otherFacts = text(await handleGraph({ files: [other], analysis: "facts" }));
    pool = hookedPool();
  });

  beforeEach(() => {
    process.env.CHIASMUS_CACHE_DIR = join(root, `cache-${++caches}`);
    const paths = resolveCachePaths({ cacheDir: process.env.CHIASMUS_CACHE_DIR, repoKey: defaultRepoKey() });
    repoDir = paths.repoDir;
    lockDir = `${paths.lockPath}.lock`;
  });

  afterAll(async () => {
    try {
      await pool.close();
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Cache `other` in a fresh child, after the dead child's lock went stale:
   * no temp file is left anywhere, and the per-file entries on disk are
   * exactly those the manifest lists, within the budget.
   */
  async function cacheOther(extra: Record<string, unknown> = {}): Promise<void> {
    await ageLock(lockDir);
    const out = text(await pool.run({
      tool: "chiasmus_graph", args: { files: [other], analysis: "facts", cache: true, ...extra },
    }));
    expect(out).toBe(otherFacts);
    expect(existsSync(lockDir)).toBe(false);
    expect(filesUnder(repoDir).filter((p) => p.endsWith(".tmp"))).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(repoDir, "manifest.json"), "utf8"));
    const listed = Object.values(manifest.entries as Record<string, { hash: string }>).map((e) => `${e.hash}.json`);
    const entries = readdirSync(join(repoDir, "files"));
    expect(entries.sort()).toEqual(listed.sort());
    const bytes = entries.reduce((n, e) => n + statSync(join(repoDir, "files", e)).size, 0);
    expect(bytes).toBeLessThanOrEqual(BUDGET);
  }

  it("reclaims a half-written per-file entry", async () => {
    const tmp = await killMidWrite(pool, root, `${sep}files${sep}`, { files: input, analysis: "facts", cache: true });
    expect(tmp.endsWith(".json.tmp")).toBe(true);
    expect(statSync(tmp).size).toBeGreaterThan(BUDGET);
    await cacheOther();
  }, 60_000);

  it("reclaims per-file entries renamed into place before the killed manifest write listed them", async () => {
    await killMidWrite(pool, root, "manifest.json.tmp", { files: input, analysis: "facts", cache: true });
    // All three entries are complete on disk, and no manifest lists them.
    expect(readdirSync(join(repoDir, "files"))).toHaveLength(3);
    expect(existsSync(join(repoDir, "manifest.json"))).toBe(false);
    await cacheOther();
  }, 60_000);

  it("reclaims a half-written snapshot, written under the lock", async () => {
    const tmp = await killMidWrite(pool, root, `${sep}snapshots${sep}`, {
      files: input, analysis: "facts", cache: true, save_snapshot: "base",
    });
    expect(tmp.endsWith(`${sep}snapshots${sep}base.json.tmp`)).toBe(true);
    // A snapshot is written under the repo lock, like every cache temp file,
    // so the next writer to take the lock knows no live writer owns it.
    expect(existsSync(lockDir)).toBe(true);
    await cacheOther({ save_snapshot: "other" });
    expect(readdirSync(join(repoDir, "snapshots"))).toEqual(["other.json"]);
  }, 60_000);
});
