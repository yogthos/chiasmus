import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTsconfigAliases,
  EMPTY_TSCONFIG_ALIASES,
} from "../../src/graph/tsconfig-aliases.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chiasmus-tsconfig-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string) {
  const full = join(dir, relPath);
  const parent = full.substring(0, full.lastIndexOf("/"));
  if (parent && parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
}

describe("loadTsconfigAliases", () => {
  it("returns EMPTY_TSCONFIG_ALIASES when no tsconfig exists", () => {
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.hasAliases).toBe(false);
    expect(aliases.size).toBe(0);
    expect(aliases.rewrite("anything")).toBeNull();
  });

  it("returns empty when tsconfig exists but has no paths", () => {
    writeFile(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022" } }),
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.hasAliases).toBe(false);
  });

  it("resolves glob alias with default baseUrl", () => {
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.hasAliases).toBe(true);
    expect(aliases.rewrite("@/components/Button")).toBe("src/components/Button");
    expect(aliases.rewrite("@/lib/util.ts")).toBe("src/lib/util.ts");
    expect(aliases.rewrite("unrelated/path")).toBeNull();
  });

  it("resolves exact (non-glob) aliases", () => {
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          paths: {
            "my-lib": ["libs/my-lib/index"],
          },
        },
      }),
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.rewrite("my-lib")).toBe("libs/my-lib/index");
    // A sub-path miss: exact alias doesn't match "my-lib/foo"
    expect(aliases.rewrite("my-lib/foo")).toBeNull();
  });

  it("honors explicit baseUrl", () => {
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: "./pkg",
          paths: {
            "@app/*": ["app/*"],
          },
        },
      }),
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.rewrite("@app/foo")).toBe("pkg/app/foo");
  });

  it("strips JSONC comments (// and /* */)", () => {
    writeFile(
      "tsconfig.json",
      `{
        // leading comment
        "compilerOptions": {
          /* block comment */
          "paths": {
            "@/*": ["src/*"]
          }
        }
      }`,
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.rewrite("@/foo")).toBe("src/foo");
  });

  it("follows extends chain and inherits parent paths", () => {
    writeFile(
      "tsconfig.base.json",
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@base/*": ["base/*"],
          },
        },
      }),
    );
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          paths: {
            "@app/*": ["app/*"],
          },
        },
      }),
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.rewrite("@base/x")).toBe("base/x");
    expect(aliases.rewrite("@app/y")).toBe("app/y");
  });

  it("child paths override parent on conflict", () => {
    writeFile(
      "tsconfig.base.json",
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@shared/*": ["old-shared/*"],
          },
        },
      }),
    );
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          paths: {
            "@shared/*": ["new-shared/*"],
          },
        },
      }),
    );
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.rewrite("@shared/x")).toBe("new-shared/x");
  });

  it("handles extends cycle without infinite loop", () => {
    writeFile(
      "a.json",
      JSON.stringify({ extends: "./b.json", compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    );
    writeFile(
      "b.json",
      JSON.stringify({ extends: "./a.json" }),
    );
    writeFile("tsconfig.json", JSON.stringify({ extends: "./a.json" }));
    // Must terminate and at least return a valid alias map (cycle-broken).
    const aliases = loadTsconfigAliases(dir);
    expect(aliases.hasAliases).toBe(true);
  });

  it("longer alias prefix wins when two match", () => {
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/lib/*": ["libs/*"],
            "@/*": ["src/*"],
          },
        },
      }),
    );
    const aliases = loadTsconfigAliases(dir);
    // "@/lib/foo" should match "@/lib/*" not "@/*"
    expect(aliases.rewrite("@/lib/foo")).toBe("libs/foo");
    expect(aliases.rewrite("@/components/x")).toBe("src/components/x");
  });

  it("tolerates malformed json gracefully", () => {
    writeFile("tsconfig.json", "{ not valid json");
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toBe(EMPTY_TSCONFIG_ALIASES);
  });
});
