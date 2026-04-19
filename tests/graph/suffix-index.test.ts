import { describe, it, expect } from "vitest";
import {
  buildSuffixIndex,
  suffixResolveImport,
  EMPTY_SUFFIX_INDEX,
} from "../../src/graph/suffix-index.js";

const REPO = "/repo";
const f = (p: string) => `${REPO}/${p}`;

describe("buildSuffixIndex", () => {
  it("indexes files and looks up exact matches", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/a.ts"),
      f("src/b.ts"),
    ]);
    expect(idx.size).toBeGreaterThan(0);
    expect(idx.hasModuleQn("src/a.ts")).toBe(true);
    expect(idx.hasModuleQn("src/b.ts")).toBe(true);
    expect(idx.hasModuleQn("src/c.ts")).toBe(false);
  });

  it("ignores files outside the repo", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      "/somewhere-else/file.ts",
      f("src/real.ts"),
    ]);
    expect(idx.hasModuleQn("src/real.ts")).toBe(true);
  });
});

describe("suffixResolveImport", () => {
  it("returns null when the index is empty", () => {
    const r = suffixResolveImport("./foo", null, EMPTY_SUFFIX_INDEX);
    expect(r).toBeNull();
  });

  it("resolves an import to a .ts file", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/lib/foo.ts"),
      f("src/lib/bar.ts"),
    ]);
    expect(suffixResolveImport("./foo", null, idx)).toBe("src/lib/foo.ts");
    expect(suffixResolveImport("lib/foo", null, idx)).toBe("src/lib/foo.ts");
  });

  it("resolves a directory import to its index file", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/lib/index.ts"),
    ]);
    expect(suffixResolveImport("./lib", null, idx)).toBe("src/lib/index.ts");
  });

  it("resolves .js imports to .ts files (ESM convention)", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/utils.ts"),
    ]);
    expect(suffixResolveImport("./utils.js", null, idx)).toBe("src/utils.ts");
  });

  it("prefers .ts over .js when both exist", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/both.ts"),
      f("src/both.js"),
    ]);
    const resolved = suffixResolveImport("./both", null, idx);
    expect(resolved).toBe("src/both.ts");
  });

  it("uses primary guess when provided", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/components/Button.tsx"),
      f("src/components/Button.test.tsx"),
    ]);
    const resolved = suffixResolveImport(
      "./Button",
      "src/components/Button",
      idx,
    );
    expect(resolved).toBe("src/components/Button.tsx");
  });

  it("returns null when the suffix does not match any indexed file", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("src/a.ts"),
    ]);
    expect(suffixResolveImport("nonexistent/path", null, idx)).toBeNull();
  });

  it("falls back through shorter suffixes", () => {
    const idx = buildSuffixIndex(REPO, "proj", [
      f("packages/core/src/util.ts"),
    ]);
    // "packages/core/src/util" matches; any shorter suffix also does.
    expect(suffixResolveImport("core/src/util", null, idx)).toBe(
      "packages/core/src/util.ts",
    );
    expect(suffixResolveImport("src/util", null, idx)).toBe(
      "packages/core/src/util.ts",
    );
    expect(suffixResolveImport("util", null, idx)).toBe(
      "packages/core/src/util.ts",
    );
  });
});
