import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import { graphToProlog } from "../../src/graph/facts.js";
import { createPrologSolver } from "../../src/solvers/prolog-solver.js";
import { getLanguageForFile, parseSourceAsync } from "../../src/graph/parser.js";

describe("Clojure support", () => {
  describe("parser", () => {
    it("maps .clj extension to clojure", () => {
      expect(getLanguageForFile("core.clj")).toBe("clojure");
      expect(getLanguageForFile("app.cljs")).toBe("clojure");
      expect(getLanguageForFile("shared.cljc")).toBe("clojure");
    });

    it("parses Clojure source via WASM", async () => {
      const tree = await parseSourceAsync("(defn hello [x] (inc x))", "test.clj");
      expect(tree).not.toBeNull();
      expect(tree.rootNode.type).toBe("source");
    });
  });

  describe("extractor", () => {
    it("extracts defn function definitions", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn handle-request [req]
  (process req))

(defn validate [data]
  (check data))
        `,
      }]);

      const names = graph.defines.map((d) => d.name);
      expect(names).toContain("handle-request");
      expect(names).toContain("validate");
      expect(graph.defines.every((d) => d.kind === "function")).toBe(true);
    });

    it("extracts defn- as private (not exported)", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn public-fn [x] x)
(defn- private-fn [x] x)
        `,
      }]);

      const exportNames = graph.exports.map((e) => e.name);
      expect(exportNames).toContain("public-fn");
      expect(exportNames).not.toContain("private-fn");
    });

    it("extracts call relationships", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn a []
  (b)
  (c 1 2))

(defn b []
  (c))

(defn c [& args] args)
        `,
      }]);

      const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
      expect(callPairs).toContain("a->b");
      expect(callPairs).toContain("a->c");
      expect(callPairs).toContain("b->c");
    });

    it("extracts namespace-qualified calls (db/query → query)", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn handler [req]
  (db/query req)
  (auth/check req))
        `,
      }]);

      const callees = graph.calls.filter((c) => c.caller === "handler").map((c) => c.callee);
      expect(callees).toContain("query");
      expect(callees).toContain("check");
    });

    it("extracts require imports from ns form", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(ns myapp.core
  (:require [myapp.db :as db]
            [myapp.auth :refer [authenticate]]))

(defn handler [] (authenticate))
        `,
      }]);

      const importSources = graph.imports.map((i) => i.name);
      expect(importSources).toContain("myapp.db");
      expect(importSources).toContain("myapp.auth");
    });

    it("multi-file cross-namespace extraction", async () => {
      const graph = await extractGraph([
        {
          path: "core.clj",
          content: `
(ns myapp.core
  (:require [myapp.db :as db]))

(defn handler [req]
  (db/query req))
          `,
        },
        {
          path: "db.clj",
          content: `
(ns myapp.db)

(defn query [req]
  (execute req))

(defn execute [req] req)
          `,
        },
      ]);

      // Cross-file: handler calls query, query calls execute
      const callPairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
      expect(callPairs).toContain("handler->query");
      expect(callPairs).toContain("query->execute");
    });

    it("does not treat Clojure special forms as function calls", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn handler [req]
  (let [x (process req)]
    (when x
      (if (valid? x)
        (do (log x) (format x))
        (report x)))))
        `,
      }]);

      const callees = graph.calls
        .filter((c) => c.caller === "handler")
        .map((c) => c.callee);

      // Real calls must be present.
      expect(callees).toContain("process");
      expect(callees).toContain("valid?");
      expect(callees).toContain("log");
      expect(callees).toContain("format");
      expect(callees).toContain("report");

      // Special forms / macros must not appear.
      const forbidden = ["let", "when", "if", "do", "fn", "fn*", "loop", "recur",
        "cond", "case", "try", "catch", "finally", "quote", "var",
        "throw", "def", "defn", "defn-", "->", "->>", "as->",
        "some->", "some->>", "and", "or", "not", "doto", "new", "set!"];
      for (const form of forbidden) {
        expect(callees).not.toContain(form);
      }
    });

    it("deduplicates call edges", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn a []
  (b)
  (b)
  (b))

(defn b [] nil)
        `,
      }]);

      const aToBCalls = graph.calls.filter((c) => c.caller === "a" && c.callee === "b");
      expect(aToBCalls).toHaveLength(1);
    });
  });

  describe("Prolog integration", () => {
    it("Clojure graph produces valid Prolog facts", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn a [] (b))
(defn b [] (c))
(defn c [] nil)
        `,
      }]);

      const program = graphToProlog(graph);
      const solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program,
        query: "reaches(a, c).",
      });
      solver.dispose();

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.answers.length).toBeGreaterThan(0);
      }
    });

    it("dead code detection works on Clojure graph", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn main [] (used))
(defn used [] nil)
(defn- unused [] nil)
        `,
      }]);

      const program = graphToProlog(graph);
      const solver = createPrologSolver();
      const result = await solver.solve({
        type: "prolog",
        program,
        query: "dead(X).",
      });
      solver.dispose();

      expect(result.status).toBe("success");
      if (result.status === "success") {
        const dead = result.answers.map((a) => a.bindings.X);
        expect(dead).toContain("unused");
        expect(dead).not.toContain("main");
        expect(dead).not.toContain("used");
      }
    });
  });
});
