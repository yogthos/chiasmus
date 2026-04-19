import { describe, it, expect } from "vitest";
import { parseSource } from "../../src/graph/parser.js";
import {
  buildTypeEnv,
  extractClassFields,
  extractSimpleTypeName,
  stripNullable,
  type ClassFieldRegistry,
} from "../../src/graph/type-env.js";

function parseTs(code: string) {
  const tree = parseSource(code, "test.ts");
  if (!tree) throw new Error("parse failed");
  return tree.rootNode;
}

function findNode(root: any, predicate: (n: any) => boolean): any | null {
  const stack: any[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (predicate(n)) return n;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

describe("stripNullable", () => {
  it("removes null/undefined union members", () => {
    expect(stripNullable("User | null")).toBe("User");
    expect(stripNullable("User | undefined")).toBe("User");
    expect(stripNullable("null | User")).toBe("User");
    expect(stripNullable("User")).toBe("User");
  });

  it("strips trailing ? marker", () => {
    expect(stripNullable("User?")).toBe("User");
  });

  it("preserves the first concrete variant of an n-ary union", () => {
    expect(stripNullable("A | B | null")).toBe("A");
  });
});

describe("extractSimpleTypeName", () => {
  it("returns simple identifier types", () => {
    const root = parseTs("let x: User = null as any;");
    const typeNode = findNode(root, (n) => n.type === "type_annotation");
    expect(typeNode).not.toBeNull();
    expect(extractSimpleTypeName(typeNode.namedChild(0))).toBe("User");
  });

  it("rejects collection wrappers — Array<T> / Promise<T> / Map<K,V> are NOT T", () => {
    const root = parseTs(`
      let a: Array<User> = [];
      let b: Promise<Session> = null as any;
      let m: Map<string, Thing> = new Map();
    `);
    const annots: any[] = [];
    const stack: any[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.type === "type_annotation") annots.push(n);
      for (let i = n.childCount - 1; i >= 0; i--) {
        const c = n.child(i);
        if (c) stack.push(c);
      }
    }
    expect(annots.length).toBeGreaterThanOrEqual(3);
    const resolved = annots.map((a) => extractSimpleTypeName(a.namedChild(0)));
    // A variable of type `Array<User>` is an Array, not a User — attributing
    // `.push()` on it to `User.push` would be wrong. All reject.
    expect(resolved.every((r) => r === undefined)).toBe(true);
  });

  it("unwraps identity-like wrappers (Readonly<T>, Partial<T>)", () => {
    const root = parseTs(`
      let c: Readonly<Config> = null as any;
      let p: Partial<Opts> = null as any;
    `);
    const annots: any[] = [];
    const stack: any[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.type === "type_annotation") annots.push(n);
      for (let i = n.childCount - 1; i >= 0; i--) {
        const c = n.child(i);
        if (c) stack.push(c);
      }
    }
    const resolved = annots.map((a) => extractSimpleTypeName(a.namedChild(0)));
    expect(resolved).toContain("Config");
    expect(resolved).toContain("Opts");
  });

  it("rejects arr[] syntax", () => {
    const root = parseTs("let x: User[] = [];");
    const typeNode = findNode(root, (n) => n.type === "type_annotation");
    // `User[]` is Array-of-User, not User itself — must not match as a class.
    expect(extractSimpleTypeName(typeNode.namedChild(0))).toBeUndefined();
  });

  it("returns undefined for anonymous / complex types", () => {
    const root = parseTs("let x: { foo: number } = null as any;");
    const typeNode = findNode(root, (n) => n.type === "type_annotation");
    expect(extractSimpleTypeName(typeNode.namedChild(0))).toBeUndefined();
  });
});

describe("extractClassFields", () => {
  it("extracts field declarations with explicit types", () => {
    const root = parseTs(`
      class Foo {
        bar: Bar;
        private qux: Qux;
        public readonly zed: Zed;
      }
    `);
    const classNode = findNode(root, (n) => n.type === "class_declaration");
    const fields = extractClassFields(classNode);
    expect(fields.get("bar")).toBe("Bar");
    expect(fields.get("qux")).toBe("Qux");
    expect(fields.get("zed")).toBe("Zed");
  });

  it("extracts field types from new-expression initializers", () => {
    const root = parseTs(`
      class Foo {
        svc = new Service();
      }
    `);
    const classNode = findNode(root, (n) => n.type === "class_declaration");
    const fields = extractClassFields(classNode);
    expect(fields.get("svc")).toBe("Service");
  });

  it("extracts constructor property parameters", () => {
    const root = parseTs(`
      class Foo {
        constructor(
          private readonly svc: Service,
          public db: Database,
          plain: NotAField
        ) {}
      }
    `);
    const classNode = findNode(root, (n) => n.type === "class_declaration");
    const fields = extractClassFields(classNode);
    expect(fields.get("svc")).toBe("Service");
    expect(fields.get("db")).toBe("Database");
    // plain param has no visibility modifier — not a field
    expect(fields.has("plain")).toBe(false);
  });

  it("extracts getter return types as field types", () => {
    const root = parseTs(`
      class Foo {
        get config(): Config { return null as any; }
      }
    `);
    const classNode = findNode(root, (n) => n.type === "class_declaration");
    const fields = extractClassFields(classNode);
    expect(fields.get("config")).toBe("Config");
  });

  it("extracts interface property signatures", () => {
    const root = parseTs(`
      interface Foo {
        bar: Bar;
        baz: Baz;
      }
    `);
    const ifaceNode = findNode(root, (n) => n.type === "interface_declaration");
    const fields = extractClassFields(ifaceNode);
    expect(fields.get("bar")).toBe("Bar");
    expect(fields.get("baz")).toBe("Baz");
  });
});

describe("buildTypeEnv — Tier 0 (explicit annotations)", () => {
  it("resolves const x: User = ...", () => {
    const root = parseTs(`
      function f() {
        const x: User = null as any;
        x.login();
      }
    `);
    const env = buildTypeEnv(root, new Map());
    // Find the call site so scope is resolved properly
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.lookup("x", callNode)).toBe("User");
  });

  it("resolves let/var annotations", () => {
    const root = parseTs(`
      let a: A;
      var b: B;
      function g() {}
    `);
    const env = buildTypeEnv(root, new Map());
    const callNode = findNode(root, (n) => n.type === "function_declaration");
    expect(env.lookup("a", callNode)).toBe("A");
    expect(env.lookup("b", callNode)).toBe("B");
  });
});

describe("buildTypeEnv — Tier 1 (constructor inference)", () => {
  it("resolves const x = new User()", () => {
    const root = parseTs(`
      function f() {
        const x = new User();
        x.login();
      }
    `);
    const env = buildTypeEnv(root, new Map());
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.lookup("x", callNode)).toBe("User");
  });
});

describe("buildTypeEnv — Tier 2 (assignment chain)", () => {
  it("resolves const y = x when x is known", () => {
    const root = parseTs(`
      const x = new User();
      function f() {
        const y = x;
        y.login();
      }
    `);
    const env = buildTypeEnv(root, new Map());
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.lookup("y", callNode)).toBe("User");
  });
});

describe("buildTypeEnv — this resolution", () => {
  it("resolves this to the enclosing class name", () => {
    const root = parseTs(`
      class MyService {
        run() {
          this.doWork();
        }
      }
    `);
    const env = buildTypeEnv(root, new Map());
    const callNode = findNode(
      root,
      (n) => n.type === "call_expression",
    );
    expect(env.lookup("this", callNode)).toBe("MyService");
  });

  it("resolves self to the enclosing class name", () => {
    const root = parseTs(`
      class MyService {
        run() {
          self.doWork();
        }
      }
    `);
    const env = buildTypeEnv(root, new Map());
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.lookup("self", callNode)).toBe("MyService");
  });
});

describe("buildTypeEnv — resolveChain", () => {
  it("walks this.a.b.c through class field registry", () => {
    const root = parseTs(`
      class MyService {
        run() { this.a.b.c(); }
      }
    `);
    const registry: ClassFieldRegistry = new Map([
      ["MyService", new Map([["a", "A"]])],
      ["A", new Map([["b", "B"]])],
      ["B", new Map([["c", "CType"]])],
    ]);
    const env = buildTypeEnv(root, registry);
    const callNode = findNode(root, (n) => n.type === "call_expression");
    const result = env.resolveChain(["this", "a", "b"], callNode);
    expect(result).toBe("B");
  });

  it("returns undefined when any step is unknown", () => {
    const root = parseTs(`
      class MyService {
        run() { this.a.b(); }
      }
    `);
    const registry: ClassFieldRegistry = new Map([
      ["MyService", new Map([["a", "A"]])],
      // A has no fields
    ]);
    const env = buildTypeEnv(root, registry);
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.resolveChain(["this", "a", "b"], callNode)).toBeUndefined();
  });

  it("starts chain from a local variable when it has a known type", () => {
    const root = parseTs(`
      function f() {
        const svc = new MyService();
        svc.a.b.c();
      }
    `);
    const registry: ClassFieldRegistry = new Map([
      ["MyService", new Map([["a", "A"]])],
      ["A", new Map([["b", "B"]])],
    ]);
    const env = buildTypeEnv(root, registry);
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.resolveChain(["svc", "a", "b"], callNode)).toBe("B");
  });
});

describe("buildTypeEnv — scope handling", () => {
  it("function-local bindings do not leak to file scope", () => {
    const root = parseTs(`
      function f() {
        const x: Inner = null as any;
      }
      function g() {}
    `);
    const env = buildTypeEnv(root, new Map());
    // From inside g, x should NOT resolve
    const gNode = findNode(
      root,
      (n) => n.type === "function_declaration" && n.childForFieldName("name")?.text === "g",
    );
    expect(env.lookup("x", gNode)).toBeUndefined();
  });

  it("file-scope bindings resolve inside nested functions", () => {
    const root = parseTs(`
      const shared: Shared = null as any;
      function f() {
        shared.method();
      }
    `);
    const env = buildTypeEnv(root, new Map());
    const callNode = findNode(root, (n) => n.type === "call_expression");
    expect(env.lookup("shared", callNode)).toBe("Shared");
  });
});
