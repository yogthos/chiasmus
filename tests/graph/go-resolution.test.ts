import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractGraph } from "../../src/graph/extractor.js";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";

const STORE = `
package store

import "context"

type Store interface {
    EndSnapshot(ctx context.Context, id string) error
}

type pgStore struct{}

func (s *pgStore) EndSnapshot(ctx context.Context, id string) error { return nil }

type memStore struct{}

func (m memStore) EndSnapshot(ctx context.Context, id string) error { return nil }
`;

const SERVICE = `
package store

import "context"

type Service interface{ SetStatus(ctx context.Context) error }

type authzService struct{ next Service }

func (a *authzService) SetStatus(ctx context.Context) error { return a.next.SetStatus(ctx) }

type service struct{ store Store }

func (s *service) SetStatus(ctx context.Context) error { return s.store.EndSnapshot(ctx, "x") }

func decode[T any](m map[string]string) (*T, error) { return new(T), nil }

func Load(st Store) {
    _, _ = decode[int](nil)
    p := &pgStore{}
    p.EndSnapshot(nil, "y")
    st.EndSnapshot(nil, "z")
}

func main() { Load(nil) }
`;

async function graph() {
  return extractGraph([
    { path: "/repo/store/store.go", content: STORE },
    { path: "/repo/store/service.go", content: SERVICE },
  ]);
}

describe("extractGraph — Go method resolution", () => {
  it("keys methods by receiver type", async () => {
    const g = await graph();
    const methods = g.defines.filter((d) => d.kind === "method").map((d) => d.name);
    expect(methods).toEqual(expect.arrayContaining([
      "store.pgStore.EndSnapshot", "store.memStore.EndSnapshot", "store.authzService.SetStatus",
      "store.service.SetStatus", "store.Store.EndSnapshot", "store.Service.SetStatus",
    ]));
    expect(g.exports.map((e) => e.name)).toContain("store.service.SetStatus");
  });

  it("resolves calls through fields, params and locals", async () => {
    const g = await graph();
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("store.service.SetStatus->store.Store.EndSnapshot");
    expect(pairs).toContain("store.authzService.SetStatus->store.Service.SetStatus");
    expect(pairs).toContain("store.Load->store.pgStore.EndSnapshot");
    expect(pairs).toContain("store.Load->store.Store.EndSnapshot");
    expect(pairs.filter((p) => p.endsWith("->SetStatus"))).toEqual([]);
  });

  it("links interface methods to structural implementations across files", async () => {
    const g = await graph();
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("store.Store.EndSnapshot->store.pgStore.EndSnapshot");
    expect(pairs).toContain("store.Store.EndSnapshot->store.memStore.EndSnapshot");
    expect(pairs).toContain("store.Service.SetStatus->store.service.SetStatus");
    expect(pairs).toContain("store.Service.SetStatus->store.authzService.SetStatus");
  });

  it("records calls to instantiated generic functions", async () => {
    const g = await graph();
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("store.Load->store.decode");
    expect(pairs).toContain("store.decode->new");
    const dead = await runAnalysisFromGraph(g, { analysis: "dead-code", entryPoints: ["main"] });
    expect(dead.result).toEqual([]);
  });

  it("resolves bare method names to every Type.Method", async () => {
    const g = await graph();
    const callers = await runAnalysisFromGraph(g, { analysis: "callers", target: "EndSnapshot" });
    expect(callers.result).toEqual(expect.arrayContaining(["store.service.SetStatus", "store.Load", "store.Store.EndSnapshot"]));
    const exact = await runAnalysisFromGraph(g, { analysis: "callers", target: "pgStore.EndSnapshot" });
    expect(exact.result).toEqual(expect.arrayContaining(["store.Load", "store.Store.EndSnapshot"]));
    expect(exact.result).not.toContain("store.service.SetStatus");
    const r = await runAnalysisFromGraph(g, { analysis: "reachability", from: "SetStatus", to: "EndSnapshot" });
    expect(r.result).toEqual({ reachable: true });
  });

  it("reaches concrete methods through an interface", async () => {
    const g = await graph();
    const r = await runAnalysisFromGraph(g, {
      analysis: "reachability", from: "store.service.SetStatus", to: "store.pgStore.EndSnapshot",
    });
    expect(r.result).toEqual({ reachable: true });
  });

  it("falls back to every owner when the receiver type is unknown", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

type A struct{}
func (A) Close() {}
type B struct{}
func (B) Close() {}

func get() A { return A{} }

func run() {
    get().Close()
    fmt.Println("x")
}
`,
    }]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("a.run->a.A.Close");
    expect(pairs).toContain("a.run->a.B.Close");
    expect(pairs).toContain("a.run->fmt.Println");
  });

  it("scopes named results, type-switch aliases and select receives as locals", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

type T struct{}
func (t *T) Run() {}
type U struct{}
func (u *U) Run() {}

func named() (r *T, err error) {
    r.Run()
    return
}

func sw(x any) {
    switch v := x.(type) {
    case *T:
        v.Run()
    }
}

func sel(ch chan *U) {
    select {
    case w := <-ch:
        w.Run()
    }
}
`,
    }]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("a.named->a.T.Run");
    expect(pairs).not.toContain("a.named->a.U.Run");
    expect(pairs).toContain("a.sw->a.T.Run");
    expect(pairs).toContain("a.sel->a.U.Run");
    expect(pairs.filter((p) => /->[rvw]\.Run$/.test(p))).toEqual([]);
  });

  it("types NewT() locals and never self-links on an unknown receiver", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

type Wrapper struct{}

func (w *Wrapper) Register() error {
    c := pb.NewServiceClient(nil)
    c.Register()
    x := w.conn()
    return x.Register()
}
`,
    }]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("a.Wrapper.Register->pb.ServiceClient.Register");
    expect(pairs).not.toContain("a.Wrapper.Register->a.Wrapper.Register");
  });

  it("matches a bare name alongside every Type.Method", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

import "net/http"

func fetch() { http.Get("x") }

type C struct{}
func (C) Get() {}
func useC(c C) { c.Get() }
`,
    }]);
    const bare = await runAnalysisFromGraph(g, { analysis: "callers", target: "Get" });
    expect(bare.result).toEqual(expect.arrayContaining(["a.fetch", "a.useC"]));
    const exact = await runAnalysisFromGraph(g, { analysis: "callers", target: "C.Get" });
    expect(exact.result).toEqual(["a.useC"]);
  });

  it("types package-level vars and only treats imports as packages", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

import (
    "net/http"
    h "net/http"
)

var db = &DB{}

type DB struct{}
func (d *DB) Exec() {}
func (d *DB) Get() {}

func run() {
    db.Exec()
    http.Get("x")
}

func runAlias() { h.Get("x") }
`,
    }]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("a.run->a.DB.Exec");
    expect(pairs).toContain("a.run->http.Get");
    expect(pairs).not.toContain("a.run->a.DB.Get");
    expect(pairs).toContain("a.runAlias->h.Get");
    expect(pairs).not.toContain("a.runAlias->a.DB.Get");
  });

  it("promotes methods from embedded fields", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

type Base struct{}
func (b *Base) Hello() {}

type S struct{ *Base }
func (s *S) Run() { s.Hello() }
`,
    }]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("a.S.Run->a.Base.Hello");
    expect(pairs.some((p) => p.includes("S.Hello"))).toBe(false);
  });

  it("adds no edge when the caller is the only owner of the method", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

type S struct{}
func (s *S) Run() {
    x := s.child()
    x.Run()
}
`,
    }]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).not.toContain("a.S.Run->Run");
    expect(pairs).not.toContain("a.S.Run->a.S.Run");
  });

  it("skips dispatch for interfaces that embed other types", async () => {
    const g = await extractGraph([{
      path: "/repo/a.go",
      content: `
package a

type RW interface {
    Reader
    Write()
}

type X struct{}
func (X) Write() {}
`,
    }]);
    expect(g.defines.map((d) => d.name)).toContain("a.RW.Write");
    expect(g.calls.map((c) => `${c.caller}->${c.callee}`)).not.toContain("a.RW.Write->a.X.Write");
  });

  it("caps interface dispatch at the first 50 implementers by name", async () => {
    const names = Array.from({ length: 55 }, (_, i) => `T${String(54 - i).padStart(2, "0")}`);
    const content = `package a\n\ntype I interface{ Do() }\n${names.map((n) => `type ${n} struct{}\nfunc (${n}) Do() {}\n`).join("")}`;
    const g = await extractGraph([{ path: "/repo/a.go", content }]);
    const targets = g.calls.filter((c) => c.caller === "a.I.Do").map((c) => c.callee).sort();
    expect(targets).toEqual([...names].sort().slice(0, 50).map((n) => `a.${n}.Do`));
  });

  it("resolves the same Go calls from the cache", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "chiasmus-go-cache-"));
    try {
      const files = [
        { path: "/repo/store/store.go", content: STORE },
        { path: "/repo/store/service.go", content: SERVICE },
      ];
      const opts = { cache: { cacheDir, repoKey: "go" } };
      const pairs = (g: Awaited<ReturnType<typeof extractGraph>>) =>
        g.calls.map((c) => `${c.caller}->${c.callee}`).sort();
      const first = await extractGraph(files, opts);
      const second = await extractGraph(files, opts);
      expect(pairs(second)).toEqual(pairs(first));
      expect(pairs(second)).toContain("store.service.SetStatus->store.Store.EndSnapshot");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("keeps a struct's methods when an interface in another package shares its name", async () => {
    const g = await extractGraph([
      {
        path: "/repo/conn/conn.go",
        content: `
package conn

type Resolver interface{ Resolve() }

type Service struct{ r Resolver }

func (s *Service) Run() { s.r.Resolve() }
`,
      },
      {
        path: "/repo/snap/resolver.go",
        content: `
package snap

type Resolver struct{}

func (r *Resolver) Resolve() { r.resolve(1) }
func (r *Resolver) resolve(n int) { r.resolve(n - 1) }
`,
      },
    ]);
    const pairs = g.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(pairs).toContain("snap.Resolver.Resolve->snap.Resolver.resolve");
    expect(pairs).toContain("snap.Resolver.resolve->snap.Resolver.resolve");
    expect(pairs).not.toContain("snap.Resolver.Resolve->snap.Resolver.Resolve");
    expect(pairs).toContain("conn.Resolver.Resolve->snap.Resolver.Resolve");
  });
});

/** Writes a module `example.com/m` with `files` to a temp dir and extracts it. */
async function moduleGraph(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "chiasmus-go-mod-"));
  try {
    await writeFile(join(root, "go.mod"), "module example.com/m\n\ngo 1.22\n");
    const batch: Array<{ path: string; content: string }> = [];
    for (const [rel, content] of Object.entries(files)) {
      const path = join(root, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      batch.push({ path, content });
    }
    return await extractGraph(batch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const pairsOf = (g: Awaited<ReturnType<typeof extractGraph>>) => g.calls.map((c) => `${c.caller}->${c.callee}`);

describe("extractGraph — Go package-qualified names", () => {
  const SNAP = (n: string) => `package snapshot

type Store struct{}

func (s *Store) Get() {}

func NewService() *Store { return &Store{} }

func helper${n}() {}
`;
  const files = {
    "internal/a/snapshot/store.go": SNAP("A"),
    "internal/b/snapshot/store.go": SNAP("B"),
    "internal/api/api.go": `package api

import (
    "fmt"
    bsnap "example.com/m/internal/b/snapshot"
    "example.com/m/internal/a/snapshot"
    "github.com/x/go-foo/v2"
)

type Handler struct{ st bsnap.Store }

func (h *Handler) Serve() {
    h.st.Get()
    n := len("x")
    _ = new(Handler)
    fmt.Println(n)
    bar.Do()
}

func Build() {
    snapshot.NewService()
    bsnap.NewService()
}
`,
    "internal/api/other.go": `package api

type Other struct{}

func (Other) Do() {}
`,
    "internal/db/a.go": `package db

var db = &DB{}

type DB struct{}

func (d *DB) Exec() {}
`,
    "internal/db/b.go": `package db

func Run() { db.Exec() }
`,
    "cmd/app/main.go": `package main

import "example.com/m/internal/api"

func main() { api.Build() }
`,
  };

  it("keys same-named types in same-named packages by directory", async () => {
    const g = await moduleGraph(files);
    const names = g.defines.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining([
      "internal/a/snapshot.Store.Get", "internal/b/snapshot.Store.Get", "cmd/app.main",
    ]));
    const pairs = pairsOf(g);
    expect(pairs).toContain("internal/api.Handler.Serve->internal/b/snapshot.Store.Get");
    expect(pairs).not.toContain("internal/api.Handler.Serve->internal/a/snapshot.Store.Get");
    expect(g.contains).toContainEqual({ parent: "internal/a/snapshot.Store", child: "internal/a/snapshot.Store.Get" });
  });

  it("links same-named functions to the imported package", async () => {
    const pairs = pairsOf(await moduleGraph(files));
    expect(pairs).toContain("internal/api.Build->internal/a/snapshot.NewService");
    expect(pairs).toContain("internal/api.Build->internal/b/snapshot.NewService");
    expect(pairs).toContain("cmd/app.main->internal/api.Build");
  });

  it("keeps builtins bare and external package calls qualified by package name", async () => {
    const pairs = pairsOf(await moduleGraph(files));
    expect(pairs).toContain("internal/api.Handler.Serve->len");
    expect(pairs).toContain("internal/api.Handler.Serve->new");
    expect(pairs).toContain("internal/api.Handler.Serve->fmt.Println");
    // `go-foo/v2` declares package `bar`: an external call, not a fan-out to Other.Do.
    expect(pairs).toContain("internal/api.Handler.Serve->bar.Do");
    expect(pairs).not.toContain("internal/api.Handler.Serve->internal/api.Other.Do");
  });

  it("types package vars declared in another file of the package", async () => {
    expect(pairsOf(await moduleGraph(files))).toContain("internal/db.Run->internal/db.DB.Exec");
  });

  it("looks up bare, partial and full names", async () => {
    const g = await moduleGraph(files);
    for (const target of ["Get", "Store.Get", "snapshot.Store.Get"]) {
      const r = await runAnalysisFromGraph(g, { analysis: "callers", target });
      expect(r.result, target).toEqual(["internal/api.Handler.Serve"]);
    }
    const full = await runAnalysisFromGraph(g, { analysis: "callers", target: "internal/b/snapshot.Store.Get" });
    expect(full.result).toEqual(["internal/api.Handler.Serve"]);
    const none = await runAnalysisFromGraph(g, { analysis: "callers", target: "internal/a/snapshot.Store.Get" });
    expect(none.result).toEqual([]);
    const dead = await runAnalysisFromGraph(g, { analysis: "dead-code", entryPoints: ["main"] });
    expect(dead.result).not.toContain("internal/api.Build");
    expect(dead.result).not.toContain("internal/a/snapshot.NewService");
    expect(dead.result).not.toContain("cmd/app.main");
    expect(dead.result).toContain("internal/a/snapshot.helperA");
    expect(dead.result).toContain("internal/db.Run");
  });
});
