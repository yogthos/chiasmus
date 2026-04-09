import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `chiasmus-config-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadConfig", () => {
  it("returns defaults when config.json does not exist", () => {
    const config = loadConfig("/nonexistent/path");
    expect(config.adapterDiscovery).toBe(false);
  });

  it("reads adapterDiscovery from config.json", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ adapterDiscovery: true }));
      const config = loadConfig(dir);
      expect(config.adapterDiscovery).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to defaults for invalid JSON", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "config.json"), "not valid json {{{");
      const config = loadConfig(dir);
      expect(config.adapterDiscovery).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("ignores unknown keys and wrong types", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        adapterDiscovery: "yes",
        unknownKey: 42,
      }));
      const config = loadConfig(dir);
      expect(config.adapterDiscovery).toBe(false); // "yes" is not boolean
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
