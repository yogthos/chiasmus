import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";

describe("extractGraph", () => {
  it("extracts function declarations", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function handleRequest() {}
        function validate() {}
      `,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("handleRequest");
    expect(names).toContain("validate");
    expect(graph.defines.every((d) => d.kind === "function")).toBe(true);
    expect(graph.defines.every((d) => d.file === "test.ts")).toBe(true);
  });

  it("extracts arrow functions assigned to const", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `const processData = (x: number) => { return x; };`,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("processData");
  });

  it("extracts call relationships", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function a() { b(); c(); }
        function b() { c(); }
        function c() {}
      `,
    }]);

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("a->b");
    expect(callPairs).toContain("a->c");
    expect(callPairs).toContain("b->c");
  });

  it("extracts method calls from member expressions", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        function foo() { this.bar(); obj.baz(); }
        function bar() {}
        function baz() {}
      `,
    }]);

    const callees = graph.calls.filter((c) => c.caller === "foo").map((c) => c.callee);
    expect(callees).toContain("bar");
    expect(callees).toContain("baz");
  });

  it("extracts class with methods and produces defines + contains", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        class MyService {
          handleRequest() {}
          validate() {}
        }
      `,
    }]);

    const classDefine = graph.defines.find((d) => d.name === "MyService");
    expect(classDefine).toBeDefined();
    expect(classDefine!.kind).toBe("class");

    const methods = graph.defines.filter((d) => d.kind === "method");
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("handleRequest");
    expect(methodNames).toContain("validate");

    const containsPairs = graph.contains.map((c) => `${c.parent}->${c.child}`);
    expect(containsPairs).toContain("MyService->handleRequest");
    expect(containsPairs).toContain("MyService->validate");
  });

  it("extracts import statements", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `import { query, validate } from './db';`,
    }]);

    expect(graph.imports).toHaveLength(2);
    const names = graph.imports.map((i) => i.name);
    expect(names).toContain("query");
    expect(names).toContain("validate");
    expect(graph.imports.every((i) => i.source === "./db")).toBe(true);
  });

  it("extracts export statements", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `
        export function main() {}
        export { helper };
      `,
    }]);

    const exportNames = graph.exports.map((e) => e.name);
    expect(exportNames).toContain("main");
    expect(exportNames).toContain("helper");
  });

  it("combines facts across multiple files", async () => {
    const graph = await extractGraph([
      {
        path: "server.ts",
        content: `
          import { query } from './db';
          export function handleRequest() { query(); }
        `,
      },
      {
        path: "db.ts",
        content: `export function query() { connect(); }
                  function connect() {}`,
      },
    ]);

    // Cross-file: handleRequest calls query, query calls connect
    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("handleRequest->query");
    expect(callPairs).toContain("query->connect");

    // Imports
    expect(graph.imports.some((i) => i.name === "query" && i.source === "./db")).toBe(true);

    // Exports from both files
    const exportNames = graph.exports.map((e) => e.name);
    expect(exportNames).toContain("handleRequest");
    expect(exportNames).toContain("query");
  });

  it("deduplicates call edges", async () => {
    const graph = await extractGraph([{
      path: "test.ts",
      content: `function a() { b(); b(); b(); }
                function b() {}`,
    }]);

    const aToBCalls = graph.calls.filter((c) => c.caller === "a" && c.callee === "b");
    expect(aToBCalls).toHaveLength(1);
  });

  it("skips unsupported file extensions", async () => {
    const graph = await extractGraph([{
      path: "test.rb",
      content: `def hello; puts "hi"; end`,
    }]);

    expect(graph.defines).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
  });
});

describe("extractGraph — Python", () => {
  it("extracts function definitions", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
def handle_request():
    pass

def validate():
    pass
`,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("handle_request");
    expect(names).toContain("validate");
    expect(graph.defines.every((d) => d.kind === "function")).toBe(true);
  });

  it("extracts class with methods and contains", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return self.name
`,
    }]);

    const classDef = graph.defines.find((d) => d.name === "Animal");
    expect(classDef).toBeDefined();
    expect(classDef!.kind).toBe("class");

    const methods = graph.defines.filter((d) => d.kind === "method");
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("__init__");
    expect(methodNames).toContain("speak");

    const containsPairs = graph.contains.map((c) => `${c.parent}->${c.child}`);
    expect(containsPairs).toContain("Animal->__init__");
    expect(containsPairs).toContain("Animal->speak");
  });

  it("extracts call relationships", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
def greet(name):
    return format_name(name)

def format_name(name):
    return name.strip()

def main():
    print(greet("hi"))
`,
    }]);

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("greet->format_name");
    expect(callPairs).toContain("main->print");
    expect(callPairs).toContain("main->greet");
  });

  it("extracts method calls via attribute access", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
class Dog:
    def speak(self):
        return self.greet("woof")

    def greet(self, sound):
        return format(sound)
`,
    }]);

    const callees = graph.calls.filter((c) => c.caller === "speak").map((c) => c.callee);
    expect(callees).toContain("greet");
  });

  it("extracts import statements", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
import os
from pathlib import Path
from collections import defaultdict as dd
`,
    }]);

    const names = graph.imports.map((i) => i.name);
    expect(names).toContain("os");
    expect(names).toContain("Path");
    expect(names).toContain("dd");

    const pathImport = graph.imports.find((i) => i.name === "Path");
    expect(pathImport!.source).toBe("pathlib");
  });

  it("extracts cross-file call graph", async () => {
    const graph = await extractGraph([
      {
        path: "app.py",
        content: `
from db import query

def handle():
    query()
`,
      },
      {
        path: "db.py",
        content: `
def query():
    connect()

def connect():
    pass
`,
      },
    ]);

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("handle->query");
    expect(callPairs).toContain("query->connect");
  });

  it("deduplicates call edges", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
def a():
    b()
    b()
    b()

def b():
    pass
`,
    }]);

    const aToBCalls = graph.calls.filter((c) => c.caller === "a" && c.callee === "b");
    expect(aToBCalls).toHaveLength(1);
  });

  it("nested functions inside functions are kind=function not method", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `
def outer():
    def inner():
        pass
    inner()
`,
    }]);

    const inner = graph.defines.find((d) => d.name === "inner");
    expect(inner).toBeDefined();
    expect(inner!.kind).toBe("function");
  });

  it("extracts multiple imports from a single from-import statement", async () => {
    const graph = await extractGraph([{
      path: "test.py",
      content: `from foo import a, b, c`,
    }]);

    const names = graph.imports.map((i) => i.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toContain("c");
    expect(graph.imports.every((i) => i.source === "foo")).toBe(true);
  });
});

describe("extractGraph — Go", () => {
  it("extracts function declarations", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

func handleRequest() {}
func validate() {}
`,
    }]);

    const names = graph.defines.map((d) => d.name);
    expect(names).toContain("handleRequest");
    expect(names).toContain("validate");
    expect(graph.defines.every((d) => d.kind === "function")).toBe(true);
  });

  it("extracts methods with receiver type and contains", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

type Animal struct {
    Name string
}

func (a *Animal) Speak() string {
    return a.Name
}

func (a Animal) Greet() string {
    return "hi"
}
`,
    }]);

    const structDef = graph.defines.find((d) => d.name === "Animal");
    expect(structDef).toBeDefined();
    expect(structDef!.kind).toBe("class");

    const methods = graph.defines.filter((d) => d.kind === "method");
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("Speak");
    expect(methodNames).toContain("Greet");

    const containsPairs = graph.contains.map((c) => `${c.parent}->${c.child}`);
    expect(containsPairs).toContain("Animal->Speak");
    expect(containsPairs).toContain("Animal->Greet");
  });

  it("extracts call relationships", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

import "fmt"

func greet(name string) string {
    return fmt.Sprintf("Hello %s", name)
}

func main() {
    fmt.Println(greet("world"))
}
`,
    }]);

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("greet->Sprintf");
    expect(callPairs).toContain("main->Println");
    expect(callPairs).toContain("main->greet");
  });

  it("extracts interface definitions", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

type Speaker interface {
    Speak() string
}
`,
    }]);

    const iface = graph.defines.find((d) => d.name === "Speaker");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");
  });

  it("extracts import declarations", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

import (
    "fmt"
    "strings"
)
`,
    }]);

    const names = graph.imports.map((i) => i.name);
    expect(names).toContain("fmt");
    expect(names).toContain("strings");
  });

  it("exports uppercase symbols only", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

func Exported() {}
func unexported() {}

type MyStruct struct {}
type myPrivate struct {}
`,
    }]);

    const exportNames = graph.exports.map((e) => e.name);
    expect(exportNames).toContain("Exported");
    expect(exportNames).toContain("MyStruct");
    expect(exportNames).not.toContain("unexported");
    expect(exportNames).not.toContain("myPrivate");
  });

  it("extracts cross-file call graph", async () => {
    const graph = await extractGraph([
      {
        path: "main.go",
        content: `
package main

func main() {
    Handle()
}

func Handle() {
    Query()
}
`,
      },
      {
        path: "db.go",
        content: `
package main

func Query() {
    connect()
}

func connect() {}
`,
      },
    ]);

    const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
    expect(callPairs).toContain("main->Handle");
    expect(callPairs).toContain("Handle->Query");
    expect(callPairs).toContain("Query->connect");
  });

  it("deduplicates call edges", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

func a() {
    b()
    b()
    b()
}

func b() {}
`,
    }]);

    const aToBCalls = graph.calls.filter((c) => c.caller === "a" && c.callee === "b");
    expect(aToBCalls).toHaveLength(1);
  });

  it("does not export underscore-prefixed or lowercase identifiers", async () => {
    const graph = await extractGraph([{
      path: "test.go",
      content: `
package main

func _helper() {}
type _internal struct {}
`,
    }]);

    expect(graph.exports).toHaveLength(0);
  });
});
