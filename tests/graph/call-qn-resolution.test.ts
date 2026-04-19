import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";

describe("TS/JS qualified call resolution (R3)", () => {
  it("this.method() on a class method resolves to Class.method", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Foo {
          run() { this.worker(); }
          worker() {}
        }
      `,
    }]);

    const runCall = graph.calls.find(
      (c) => c.caller === "run" && c.callee === "worker",
    );
    expect(runCall).toBeDefined();
    expect(runCall!.calleeQN).toBe("Foo.worker");
  });

  it("localVar.method() with explicit annotation resolves receiver type", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Svc { login() {} }
        function f() {
          const s: Svc = new Svc();
          s.login();
        }
      `,
    }]);
    const loginCall = graph.calls.find(
      (c) => c.caller === "f" && c.callee === "login",
    );
    expect(loginCall).toBeDefined();
    expect(loginCall!.calleeQN).toBe("Svc.login");
  });

  it("localVar.method() with new-expression inference resolves receiver type", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Svc { run() {} }
        function main() {
          const s = new Svc();
          s.run();
        }
      `,
    }]);
    const runCall = graph.calls.find(
      (c) => c.caller === "main" && c.callee === "run",
    );
    expect(runCall).toBeDefined();
    expect(runCall!.calleeQN).toBe("Svc.run");
  });

  it("this.field.method() chain resolves via class field registry", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Svc { login() {} }
        class App {
          svc: Svc;
          start() { this.svc.login(); }
        }
      `,
    }]);
    const loginCall = graph.calls.find(
      (c) => c.caller === "start" && c.callee === "login",
    );
    expect(loginCall).toBeDefined();
    expect(loginCall!.calleeQN).toBe("Svc.login");
  });

  it("constructor property params become class fields for chain resolution", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Auth { login() {} }
        class App {
          constructor(private readonly auth: Auth) {}
          start() { this.auth.login(); }
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "start" && c.callee === "login",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("Auth.login");
  });

  it("cross-file chain via class field registry", async () => {
    const graph = await extractGraph([
      {
        path: "svc.ts",
        content: `export class Svc { login() {} }`,
      },
      {
        path: "app.ts",
        content: `
          import { Svc } from './svc.js';
          class App {
            svc: Svc;
            run() { this.svc.login(); }
          }
        `,
      },
    ]);
    const call = graph.calls.find(
      (c) => c.caller === "run" && c.callee === "login",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("Svc.login");
  });

  it("array receivers do not misattribute to element class", async () => {
    // `defines.push(x)` where `defines: DefinesFact[]` is Array.push,
    // not DefinesFact.push. The resolver must not emit a calleeQN here.
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        interface DefinesFact { name: string }
        function extract() {
          const defines: DefinesFact[] = [];
          defines.push({ name: "x" });
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "extract" && c.callee === "push",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBeUndefined();
  });

  it("Array<T> / Promise<T> / Map<K,V> receivers do not misattribute", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Item { run() {} }
        function f() {
          const xs: Array<Item> = [];
          xs.forEach(x => x.run());  // forEach is Array method, not Item
          const p: Promise<Item> = null as any;
          p.then(x => x);  // then is Promise method, not Item
          const m: Map<string, Item> = new Map();
          m.get("k");  // get is Map method, not Item
        }
      `,
    }]);
    // None of forEach/then/get on the wrapped types should get a QN.
    const bad = graph.calls.find(
      (c) =>
        c.caller === "f" &&
        (c.calleeQN === "Item.forEach" ||
          c.calleeQN === "Item.then" ||
          c.calleeQN === "Item.get"),
    );
    expect(bad).toBeUndefined();
  });

  it("does not set calleeQN when receiver type is unknown", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function f(x: any) {
          x.someMethod();
        }
      `,
    }]);
    // The callee is still captured (existing behavior), but without QN.
    const call = graph.calls.find(
      (c) => c.caller === "f" && c.callee === "someMethod",
    );
    if (call) {
      expect(call.calleeQN).toBeUndefined();
    }
  });

  it("JS builtins like Map / Set / Promise do not produce QNs", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function f() {
          const m = new Map();
          m.has("k");
          const s = new Set();
          s.add(1);
          const p = new Promise(() => {});
          p.then(() => {});
        }
      `,
    }]);
    for (const c of graph.calls.filter((c) => c.caller === "f")) {
      expect(c.calleeQN).toBeUndefined();
    }
  });

  it("primitive type annotations do not produce QNs", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function f(s: string, n: number) {
          s.trim();
          n.toFixed(2);
        }
      `,
    }]);
    for (const c of graph.calls.filter((c) => c.caller === "f")) {
      expect(c.calleeQN).toBeUndefined();
    }
  });

  it("bare function call has no calleeQN", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function helper() {}
        function main() { helper(); }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "main" && c.callee === "helper",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBeUndefined();
  });

  it("JS also benefits when new-expression receiver is unambiguous", async () => {
    const graph = await extractGraph([{
      path: "test.js",
      content: `
        class Svc { login() {} }
        function main() {
          const s = new Svc();
          s.login();
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "main" && c.callee === "login",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("Svc.login");
  });

  it("existing name-based callee continues to work (back-compat)", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Foo {
          a() { this.b(); }
          b() {}
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "a" && c.callee === "b",
    );
    expect(call).toBeDefined();
    // Back-compat: raw name is still there
    expect(call!.callee).toBe("b");
  });
});
