import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  LocalEmbeddingAdapter,
  resolveLocalEmbeddingConfig,
  type EmbeddingSession,
} from "../src/llm/local-embeddings.js";
import type { ChiasmusConfig } from "../src/config.js";

/** A fake embedding session: returns a fixed-dimension vector per text. */
function fakeSession(dim: number): EmbeddingSession & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts: string[]) {
      calls.push([...texts]);
      return texts.map(() => Array.from({ length: dim }, (_, i) => i / dim));
    },
    async dispose() {},
  };
}

describe("LocalEmbeddingAdapter", () => {
  it("does not load the model until the first embed()", async () => {
    const loadModel = vi.fn(async () => fakeSession(4));
    const adapter = new LocalEmbeddingAdapter({ model: "m", loadModel });
    expect(loadModel).not.toHaveBeenCalled();
    expect(() => adapter.dimension()).toThrow();
    await adapter.embed(["hi"]);
    expect(loadModel).toHaveBeenCalledTimes(1);
  });

  it("returns [] for empty input without loading the model", async () => {
    const loadModel = vi.fn(async () => fakeSession(4));
    const adapter = new LocalEmbeddingAdapter({ model: "m", loadModel });
    const out = await adapter.embed([]);
    expect(out).toEqual([]);
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("discovers the dimension from the first embedding and reports it afterwards", async () => {
    const adapter = new LocalEmbeddingAdapter({ model: "m", loadModel: async () => fakeSession(8) });
    await adapter.embed(["hi"]);
    expect(adapter.dimension()).toBe(8);
  });

  it("reports a configured dimension eagerly, before any embed", () => {
    const adapter = new LocalEmbeddingAdapter({
      model: "m",
      dimension: 1024,
      loadModel: async () => fakeSession(8),
    });
    expect(adapter.dimension()).toBe(1024);
  });

  it("loads the model exactly once across concurrent embed() calls", async () => {
    let resolveLoad: (s: EmbeddingSession) => void = () => {};
    const loadModel = vi.fn(
      () =>
        new Promise<EmbeddingSession>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const adapter = new LocalEmbeddingAdapter({ model: "m", loadModel });
    const p1 = adapter.embed(["a"]);
    const p2 = adapter.embed(["b"]);
    resolveLoad(fakeSession(4));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it("does not cache a failed load — a subsequent embed retries", async () => {
    let first = true;
    const loadModel = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
      return fakeSession(4);
    });
    const adapter = new LocalEmbeddingAdapter({ model: "m", loadModel });
    await expect(adapter.embed(["a"])).rejects.toThrow("boom");
    const out = await adapter.embed(["b"]);
    expect(loadModel).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
  });

  it("chunks embed() calls by batchSize", async () => {
    const session = fakeSession(2);
    const adapter = new LocalEmbeddingAdapter({
      model: "m",
      batchSize: 2,
      loadModel: async () => session,
    });
    await adapter.embed(["a", "b", "c", "d", "e"]);
    expect(session.calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("can be disposed without ever loading the model", async () => {
    const adapter = new LocalEmbeddingAdapter({ model: "m", loadModel: async () => fakeSession(4) });
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});

describe("resolveLocalEmbeddingConfig", () => {
  const baseEnv = () => ({});

  it("is disabled when nothing is configured", () => {
    expect(resolveLocalEmbeddingConfig(undefined, baseEnv()).enabled).toBe(false);
  });

  it("is disabled when the config block is present but enabled is false", () => {
    const config: ChiasmusConfig = {
      adapterDiscovery: false,
      localEmbeddings: { enabled: false, model: "hf:foo/bar" },
    };
    expect(resolveLocalEmbeddingConfig(config, baseEnv()).enabled).toBe(false);
  });

  it("enables via the config block and carries model/dimension/modelsDir", () => {
    const config: ChiasmusConfig = {
      adapterDiscovery: false,
      localEmbeddings: {
        enabled: true,
        model: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF",
        dimension: 1024,
        modelsDir: "/opt/models",
      },
    };
    const r = resolveLocalEmbeddingConfig(config, baseEnv());
    expect(r).toEqual({
      enabled: true,
      model: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF",
      dimension: 1024,
      modelsDir: "/opt/models",
      batchSize: 32,
    });
  });

  it("enables via env vars alone", () => {
    const r = resolveLocalEmbeddingConfig(undefined, {
      CHIASMUS_LOCAL_EMBED: "1",
      CHIASMUS_LOCAL_EMBED_MODEL: "hf:foo/bar",
      CHIASMUS_LOCAL_EMBED_DIM: "512",
      CHIASMUS_LOCAL_EMBED_DIR: "/env/models",
    });
    expect(r.enabled).toBe(true);
    expect(r.model).toBe("hf:foo/bar");
    expect(r.dimension).toBe(512);
    expect(r.modelsDir).toBe("/env/models");
  });

  it("accepts truthy CHIASMUS_LOCAL_EMBED values (true/yes/on)", () => {
    for (const v of ["true", "yes", "on", "1"]) {
      expect(
        resolveLocalEmbeddingConfig(undefined, { CHIASMUS_LOCAL_EMBED: v }).enabled,
      ).toBe(true);
    }
    for (const v of ["false", "0", "no", ""]) {
      expect(
        resolveLocalEmbeddingConfig(undefined, { CHIASMUS_LOCAL_EMBED: v }).enabled,
      ).toBe(false);
    }
  });

  it("env values override config values", () => {
    const config: ChiasmusConfig = {
      adapterDiscovery: false,
      localEmbeddings: { enabled: true, model: "hf:config/model", dimension: 768 },
    };
    const r = resolveLocalEmbeddingConfig(config, {
      CHIASMUS_LOCAL_EMBED_MODEL: "hf:env/model",
    });
    expect(r.model).toBe("hf:env/model");
    expect(r.dimension).toBe(768);
  });

  it("defaults modelsDir to chiasmusHome/models when not specified", () => {
    const r = resolveLocalEmbeddingConfig(
      { adapterDiscovery: false, localEmbeddings: { enabled: true, model: "hf:foo/bar" } },
      baseEnv(),
      "/home/.chiasmus",
    );
    expect(r.modelsDir).toBe("/home/.chiasmus/models");
  });

  it("can be enabled even without a model (selection warns)", () => {
    const r = resolveLocalEmbeddingConfig(undefined, { CHIASMUS_LOCAL_EMBED: "1" });
    expect(r.enabled).toBe(true);
    expect(r.model).toBeUndefined();
  });

  it("parses batchSize from env", () => {
    const r = resolveLocalEmbeddingConfig(
      undefined,
      { CHIASMUS_LOCAL_EMBED: "1", CHIASMUS_LOCAL_EMBED_MODEL: "hf:foo/bar", CHIASMUS_LOCAL_EMBED_BATCH: "8" },
    );
    expect(r.batchSize).toBe(8);
  });
});

describe("node-llama-cpp packaging", () => {
  it("is declared as an optionalDependency so it resolves on global + npx installs", () => {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.optionalDependencies?.["node-llama-cpp"]).toBeTruthy();
  });
});
