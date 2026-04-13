import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalysis } from "../../src/graph/analyses.js";
import { checkFileCache } from "../../src/graph/cache.js";

describe("runAnalysis cache plumbing", () => {
  let cacheDir: string;
  let workDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-analyses-cache-"));
    workDir = await mkdtemp(join(tmpdir(), "chiasmus-analyses-src-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("populates the cache when cache=true", async () => {
    const filePath = join(workDir, "a.ts");
    await writeFile(filePath, "function a() {}");

    await runAnalysis([filePath], {
      analysis: "summary",
      cache: { cacheDir, repoKey: "ra-test" },
    });

    const { hits } = await checkFileCache(
      [{ path: filePath, content: "function a() {}" }],
      { cacheDir, repoKey: "ra-test" },
    );
    expect(hits).toHaveLength(1);
  });

  it("does not populate cache when cache option omitted", async () => {
    const filePath = join(workDir, "a.ts");
    await writeFile(filePath, "function a() {}");

    await runAnalysis([filePath], { analysis: "summary" });

    const { hits } = await checkFileCache(
      [{ path: filePath, content: "function a() {}" }],
      { cacheDir, repoKey: "ra-test" },
    );
    expect(hits).toHaveLength(0);
  });

  it("second call with same inputs uses the cache", async () => {
    const filePath = join(workDir, "a.ts");
    await writeFile(filePath, "function a() { b(); } function b() {}");
    const opts = { cacheDir, repoKey: "ra-test" };

    const r1 = await runAnalysis([filePath], { analysis: "summary", cache: opts });
    const r2 = await runAnalysis([filePath], { analysis: "summary", cache: opts });

    expect(r2.result).toEqual(r1.result);
  });
});
