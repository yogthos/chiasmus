import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";

describe("R4: inheritance + fallback resolution", () => {
  it("inherits fields from a base class via extends", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Svc { login() {} }
        class Base {
          svc: Svc;
        }
        class Child extends Base {
          run() { this.svc.login(); }
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "run" && c.callee === "login",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("Svc.login");
  });

  it("inherits fields across files via extends", async () => {
    const graph = await extractGraph([
      {
        path: "base.ts",
        content: `
          export class Svc { login() {} }
          export class Base {
            svc: Svc;
          }
        `,
      },
      {
        path: "child.ts",
        content: `
          import { Base } from './base.js';
          class Child extends Base {
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

  it("child fields shadow parent fields", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Old { login() {} }
        class New { login() {} }
        class Base {
          svc: Old;
        }
        class Child extends Base {
          svc: New;
          run() { this.svc.login(); }
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "run" && c.callee === "login",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("New.login");
  });

  it("method-name fallback: unique method across all classes resolves", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class Svc { uniqueLogin() {} }
        function f(x: any) {
          x.uniqueLogin();
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "f" && c.callee === "uniqueLogin",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("Svc.uniqueLogin");
  });

  it("method-name fallback: ambiguous method name stays unresolved", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class A { run() {} }
        class B { run() {} }
        function f(x: any) {
          x.run();
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "f" && c.callee === "run",
    );
    expect(call).toBeDefined();
    // Ambiguous: do not guess
    expect(call!.calleeQN).toBeUndefined();
  });

  it("extends cycles do not infinite-loop", async () => {
    // Pathological: A extends B; B extends A. Should not hang.
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class A extends B {
          x: X;
        }
        class B extends A {
          y: Y;
        }
        class X { m() {} }
        class Y { m() {} }
        class App {
          a: A;
          run() { this.a.x.m(); }
        }
      `,
    }]);
    // The test passes if extractGraph returns in bounded time.
    // QN resolution might succeed or fail; we just check it doesn't hang
    // and still emits a call row.
    const call = graph.calls.find(
      (c) => c.caller === "run" && c.callee === "m",
    );
    expect(call).toBeDefined();
  });

  it("interface extends propagates methods", async () => {
    // Regression: `Api extends Svc` (interface extends) should let
    // this.api.run() resolve to Svc.run, not Api.run (which Api doesn't have).
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        interface Svc { run(): void; }
        interface Other { login(): void; }  // so run is unique to Svc
        interface Api extends Svc {}
        class App {
          api: Api;
          start() { this.api.run(); }
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "start" && c.callee === "run",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBe("Svc.run");
  });

  it("does not emit QN when final type does not define the method", async () => {
    // `this.api.nonexistent()` — Api has no `nonexistent` method, no
    // inheritance chain provides it, no other class defines it. QN must
    // stay undefined rather than guessing Api.nonexistent.
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        interface Api { run(): void; }
        class App {
          api: Api;
          start() { this.api.nonexistent(); }
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "start" && c.callee === "nonexistent",
    );
    expect(call).toBeDefined();
    expect(call!.calleeQN).toBeUndefined();
  });

  it("existing chain resolution still wins over fallback", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class A { run() {} }
        class B { run() {} }
        function f() {
          const a: A = new A();
          a.run();
        }
      `,
    }]);
    const call = graph.calls.find(
      (c) => c.caller === "f" && c.callee === "run",
    );
    expect(call).toBeDefined();
    // Chain resolution to A wins even though B also has a run().
    expect(call!.calleeQN).toBe("A.run");
  });
});
