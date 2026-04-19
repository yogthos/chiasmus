import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGraph } from "../../src/graph/extractor.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chiasmus-import-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = join(dir, rel);
  const parent = full.substring(0, full.lastIndexOf("/"));
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("import resolution (R5+R6)", () => {
  it("resolves imports to canonical file paths via suffix index", async () => {
    const a = write(
      "src/a.ts",
      `import { helper } from './helper.js';
       export function useHelp() { helper(); }`,
    );
    const helper = write(
      "src/helper.ts",
      `export function helper() {}`,
    );

    const graph = await extractGraph(
      [
        { path: a, content: readFileSync(a, "utf8") },
        { path: helper, content: readFileSync(helper, "utf8") },
      ],
      { repoPath: dir },
    );

    const importFact = graph.imports.find(
      (i) => i.file === a && i.name === "helper",
    );
    expect(importFact).toBeDefined();
    // raw source stays intact for back-compat
    expect(importFact!.source).toBe("./helper.js");
    // resolved points at the real .ts file, relative to repo root
    expect(importFact!.resolved).toBe("src/helper.ts");
  });

  it("resolves tsconfig-aliased imports (e.g. @/foo)", async () => {
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["src/*"] } },
      }),
    );
    const a = write(
      "app/main.ts",
      `import { helper } from '@/lib/helper.js';
       export function useHelp() { helper(); }`,
    );
    const helper = write(
      "src/lib/helper.ts",
      `export function helper() {}`,
    );

    const graph = await extractGraph(
      [
        { path: a, content: readFileSync(a, "utf8") },
        { path: helper, content: readFileSync(helper, "utf8") },
      ],
      { repoPath: dir },
    );

    const importFact = graph.imports.find(
      (i) => i.file === a && i.name === "helper",
    );
    expect(importFact).toBeDefined();
    expect(importFact!.source).toBe("@/lib/helper.js");
    expect(importFact!.resolved).toBe("src/lib/helper.ts");
  });

  it("resolves directory imports to index.ts", async () => {
    const a = write(
      "src/a.ts",
      `import { helper } from './lib';
       export function f() { helper(); }`,
    );
    const idx = write(
      "src/lib/index.ts",
      `export function helper() {}`,
    );

    const graph = await extractGraph(
      [
        { path: a, content: readFileSync(a, "utf8") },
        { path: idx, content: readFileSync(idx, "utf8") },
      ],
      { repoPath: dir },
    );

    const importFact = graph.imports.find((i) => i.file === a && i.name === "helper");
    expect(importFact!.resolved).toBe("src/lib/index.ts");
  });

  it("leaves `resolved` undefined for unresolved imports (e.g. external packages)", async () => {
    const a = write(
      "src/a.ts",
      `import { z } from 'zod';
       export function f() { z.object({}); }`,
    );

    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );

    const importFact = graph.imports.find((i) => i.file === a && i.name === "z");
    expect(importFact).toBeDefined();
    expect(importFact!.source).toBe("zod");
    expect(importFact!.resolved).toBeUndefined();
  });

  it("does not touch re-exports when target is external", async () => {
    // An `export { foo } from 'external-pkg'` should leave source untouched.
    const a = write(
      "src/a.ts",
      `export { foo } from 'external-pkg';`,
    );

    const graph = await extractGraph(
      [{ path: a, content: readFileSync(a, "utf8") }],
      { repoPath: dir },
    );
    const importFact = graph.imports.find((i) => i.file === a && i.name === "foo");
    expect(importFact).toBeDefined();
    expect(importFact!.source).toBe("external-pkg");
    expect(importFact!.resolved).toBeUndefined();
  });

  it("disambiguates same-basename files by importing directory", async () => {
    // Regression: "./llm/types.js" from src/mcp-server.ts must resolve to
    // src/llm/types.ts, NOT to src/graph/types.ts just because "types.ts"
    // also exists there.
    const a = write(
      "src/mcp-server.ts",
      `import { X } from './llm/types.js';
       import { Y } from './graph/types.js';
       function f() { return X; }
       function g() { return Y; }`,
    );
    const llmTypes = write("src/llm/types.ts", `export interface X {}`);
    const graphTypes = write("src/graph/types.ts", `export interface Y {}`);

    const graph = await extractGraph(
      [
        { path: a, content: readFileSync(a, "utf8") },
        { path: llmTypes, content: readFileSync(llmTypes, "utf8") },
        { path: graphTypes, content: readFileSync(graphTypes, "utf8") },
      ],
      { repoPath: dir },
    );

    const xImp = graph.imports.find((i) => i.file === a && i.name === "X");
    const yImp = graph.imports.find((i) => i.file === a && i.name === "Y");
    expect(xImp?.resolved).toBe("src/llm/types.ts");
    expect(yImp?.resolved).toBe("src/graph/types.ts");
  });

  it("does not silently match a same-basename file when intended target is missing", async () => {
    // src/skills/library.ts imports ./types.js (src/skills/types.ts)
    // but src/skills/types.ts is NOT in the batch. The ONLY types.ts in
    // the batch is src/graph/types.ts. The resolver must NOT pick it —
    // silently returning undefined is better than wrong cross-directory.
    const lib = write(
      "src/skills/library.ts",
      `import { T } from './types.js';
       export function f() { return T; }`,
    );
    const graphTypes = write(
      "src/graph/types.ts",
      `export interface T {}`,
    );

    const graph = await extractGraph(
      [
        { path: lib, content: readFileSync(lib, "utf8") },
        { path: graphTypes, content: readFileSync(graphTypes, "utf8") },
      ],
      { repoPath: dir },
    );

    const imp = graph.imports.find((i) => i.file === lib && i.name === "T");
    expect(imp).toBeDefined();
    expect(imp!.resolved).toBeUndefined();
  });

  it("resolves .. relative imports correctly", async () => {
    const a = write(
      "src/sub/a.ts",
      `import { helper } from '../helper.js'; helper();`,
    );
    const helper = write("src/helper.ts", `export function helper() {}`);

    const graph = await extractGraph(
      [
        { path: a, content: readFileSync(a, "utf8") },
        { path: helper, content: readFileSync(helper, "utf8") },
      ],
      { repoPath: dir },
    );

    const imp = graph.imports.find((i) => i.file === a && i.name === "helper");
    expect(imp?.resolved).toBe("src/helper.ts");
  });

  it("back-compat: extractGraph still works without repoPath option", async () => {
    const graph = await extractGraph([
      { path: "/virt/a.ts", content: `import { x } from './b.js'; x();` },
    ]);
    const importFact = graph.imports.find((i) => i.name === "x");
    expect(importFact).toBeDefined();
    // No repo-wide context, so nothing to resolve — source stays raw.
    expect(importFact!.source).toBe("./b.js");
  });
});
