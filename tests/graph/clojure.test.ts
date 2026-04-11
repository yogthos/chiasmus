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

  describe("dynamic dispatch forms", () => {
    it("walks defmethod bodies, attributing calls to the multi name", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defmulti handle :kind)

(defmethod handle :foo [req]
  (process-foo req))

(defmethod handle :bar [req]
  (process-bar req))

(defn- process-foo [_] nil)
(defn- process-bar [_] nil)
        `,
      }]);

      const pairs = graph.calls.map((c) => `${c.caller}->${c.callee}`);
      expect(pairs).toContain("handle->process-foo");
      expect(pairs).toContain("handle->process-bar");
    });

    it("registers defmulti as a function definition", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `(defmulti route-req :path)`,
      }]);

      const def = graph.defines.find((d) => d.name === "route-req");
      expect(def).toBeDefined();
      expect(def?.kind).toBe("function");
    });

    it("walks defrecord method bodies", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defprotocol Store
  (fetch [this k])
  (put [this k v]))

(defn- lookup [k] k)
(defn- persist [k v] [k v])

(defrecord MemStore [data]
  Store
  (fetch [_ k] (lookup k))
  (put [_ k v] (persist k v)))
        `,
      }]);

      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("lookup");
      expect(called).toContain("persist");

      const recordDef = graph.defines.find((d) => d.name === "MemStore");
      expect(recordDef).toBeDefined();
      expect(recordDef?.kind).toBe("class");
    });

    it("walks deftype method bodies", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defprotocol P (act [this]))
(defn- helper [] :done)

(deftype T []
  P
  (act [_] (helper)))
        `,
      }]);

      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("helper");
    });

    it("walks extend-type method bodies", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defprotocol P (do-it [x]))
(defn- aux [] nil)

(extend-type String
  P
  (do-it [_] (aux)))
        `,
      }]);

      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("aux");
    });

    it("walks extend-protocol method bodies", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defprotocol P (do-it [x]))
(defn- aux-a [] nil)
(defn- aux-b [] nil)

(extend-protocol P
  String
  (do-it [_] (aux-a))
  Number
  (do-it [_] (aux-b)))
        `,
      }]);

      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("aux-a");
      expect(called).toContain("aux-b");
    });

    it("registers defprotocol method names as function definitions", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defprotocol Shape
  (area [this])
  (perimeter [this]))
        `,
      }]);

      const names = new Set(graph.defines.map((d) => d.name));
      expect(names).toContain("Shape");
      expect(names).toContain("area");
      expect(names).toContain("perimeter");
    });
  });

  describe("higher-order function references", () => {
    it("treats sym args of clojure.core HOFs as reference edges", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- unqualify-keys [m] m)
(defn- private-key-file? [f] f)

(defn execute-query [db sql]
  (mapv unqualify-keys (pg-execute db sql)))

(defn list-keys [dir]
  (filter private-key-file? (file-seq dir)))
        `,
      }]);

      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("unqualify-keys");
      expect(called).toContain("private-key-file?");
    });

    it("handles apply/partial/comp with fn args", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- transform [x] x)
(defn- step [a b] [a b])

(defn run [coll x]
  (apply transform coll)
  (partial step x)
  (comp transform step))
        `,
      }]);

      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("transform");
      expect(called).toContain("step");
    });
  });

  describe("list head disambiguation", () => {
    it("does not treat the 2nd sym in a keyword-first list as a callee", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn handler [req]
  (let [kp (get-keypair req)]
    (:public-key kp)))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "handler").map((c) => c.callee));
      expect(callees).toContain("get-keypair");
      expect(callees).not.toContain("kp"); // kp is a local, not a callee
    });

    it("does not treat args of map-first / set-first lists as callees", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn check [result x]
  (#{:green :yellow} (:colour result))
  ({:a 1 :b 2} x))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "check").map((c) => c.callee));
      expect(callees).not.toContain("result");
      expect(callees).not.toContain("x");
    });
  });

  describe("form-container recursion", () => {
    it("extracts calls inside anon_fn_lit #(...)", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- bytes->lat [bs] bs)

(defn load-all [items]
  (mapv #(bytes->lat (:raw %)) items))
        `,
      }]);
      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("bytes->lat");
    });

    it("extracts calls inside reader conditional #?(...)", async () => {
      const graph = await extractGraph([{
        path: "core.cljc",
        content: `
(defn- clj-impl [] :clj)
(defn- cljs-impl [] :cljs)

(defn go []
  #?(:clj (clj-impl)
     :cljs (cljs-impl)))
        `,
      }]);
      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("clj-impl");
      expect(called).toContain("cljs-impl");
    });

    it("extracts calls inside derefing_lit @(...)", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- make-promise [] nil)

(defn run []
  @(make-promise))
        `,
      }]);
      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("make-promise");
    });
  });

  describe("threading macros", () => {
    it("emits edges for bare-symbol calls in -> body", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- step1 [x] x)
(defn- step2 [x] x)

(defn pipeline [x]
  (-> x step1 step2 (inc) (* 2)))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "pipeline").map((c) => c.callee));
      expect(callees).toContain("step1");
      expect(callees).toContain("step2");
      expect(callees).toContain("inc");
      expect(callees).not.toContain("x"); // value being threaded, not a callee
    });

    it("emits edges for bare-symbol calls in ->> body", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- finalize [coll] coll)

(defn run [items]
  (->> items (map inc) (filter even?) finalize set))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "run").map((c) => c.callee));
      expect(callees).toContain("finalize");
      expect(callees).toContain("set");
      expect(callees).not.toContain("items");
    });

    it("does not flag bare-sym-called helpers as dead in thread-last chains", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- normalize [x] x)

(defn process [xs]
  (->> xs (map inc) normalize))
        `,
      }]);
      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("normalize");
    });
  });

  describe("HOF fn-slot precision", () => {
    it("emits only the fn arg, not collection args, for arg1-HOFs", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn run [coll init]
  (reduce combine init coll)
  (filter pred? coll))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "run").map((c) => c.callee));
      expect(callees).toContain("combine");
      expect(callees).toContain("pred?");
      expect(callees).not.toContain("coll"); // collection, not a fn
      expect(callees).not.toContain("init");  // accumulator value, not a fn
    });

    it("emits all sym args for comp/juxt (every arg is a fn)", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- a [x] x)
(defn- b [x] x)
(defn- c [x] x)

(defn build []
  (comp a b c)
  (juxt a b c))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "build").map((c) => c.callee));
      expect(callees).toContain("a");
      expect(callees).toContain("b");
      expect(callees).toContain("c");
    });

    it("emits only the fn for partial (rest are bound args)", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn run [x]
  (partial handler x 42))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "run").map((c) => c.callee));
      expect(callees).toContain("handler");
      expect(callees).not.toContain("x");
    });
  });

  describe("test macros", () => {
    it("walks deftest bodies and attributes calls to the test name", async () => {
      const graph = await extractGraph([{
        path: "foo_test.clj",
        content: `
(ns foo-test
  (:require [clojure.test :refer [deftest is]]))

(defn- helper [x] x)

(deftest my-feature-test
  (is (= 1 (helper 1))))
        `,
      }]);
      const called = new Set(graph.calls.map((c) => c.callee));
      expect(called).toContain("helper");
      const names = new Set(graph.defines.map((d) => d.name));
      expect(names).toContain("my-feature-test");
    });

    it("does not flag test-only helpers as dead", async () => {
      const graph = await extractGraph([{
        path: "foo_test.clj",
        content: `
(ns foo-test
  (:require [clojure.test :refer [deftest is]]))

(defn- bytes= [a b] (= a b))
(defn- test-config [] {})

(deftest round-trip
  (let [cfg (test-config)]
    (is (bytes= cfg cfg))))
        `,
      }]);
      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("bytes=");
      expect(dead).not.toContain("test-config");
    });
  });

  describe("top-level side-effecting forms", () => {
    it("walks top-level forms using the ns name as caller", async () => {
      const graph = await extractGraph([{
        path: "foo_test.clj",
        content: `
(ns foo-test
  (:require [clojure.test :refer [use-fixtures]]))

(defn- tmp-dir-fixture [f] (f))

(use-fixtures :each tmp-dir-fixture)
        `,
      }]);
      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("tmp-dir-fixture");
    });

    it("walks def value expressions for call edges", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(ns myapp.core)

(defn- load-config [path] path)

(def config (load-config "config.edn"))
        `,
      }]);
      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("load-config");
    });
  });

  describe("threading variants (as->, cond->, cond->>, doto)", () => {
    it("as-> emits edges for bare-symbol fn calls, skipping the binding name", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- step-a [x] x)
(defn- step-b [x] x)

(defn pipeline [init]
  (as-> init $
    step-a
    (process $)
    step-b))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "pipeline").map((c) => c.callee));
      expect(callees).toContain("step-a");
      expect(callees).toContain("step-b");
      expect(callees).toContain("process");
      expect(callees).not.toContain("$"); // binding name, not a callee
      expect(callees).not.toContain("init"); // value, not a callee
    });

    it("cond-> emits edges for bare-symbol fn calls", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- annotate [x] x)
(defn- dec-count [x] x)

(defn maybe-transform [x flag]
  (cond-> x
    flag     annotate
    (pos? x) dec-count
    true     (update :n inc)))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "maybe-transform").map((c) => c.callee));
      expect(callees).toContain("annotate");
      expect(callees).toContain("dec-count");
      expect(callees).toContain("pos?");
      expect(callees).toContain("update");
    });

    it("cond->> emits edges for bare-symbol fn calls", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- sort-items [coll] coll)

(defn build [xs sort?]
  (cond->> xs
    true   (filter :active)
    sort?  sort-items))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "build").map((c) => c.callee));
      expect(callees).toContain("sort-items");
      expect(callees).toContain("filter");
    });

    it("doto emits edges for bare-symbol fn calls", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- initialize [obj] obj)

(defn setup [builder]
  (doto builder
    initialize
    (.append "x")
    (.append "y")))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "setup").map((c) => c.callee));
      expect(callees).toContain("initialize");
    });

    it("does not flag helpers used only in as-> as dead", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- normalize-keys [m] m)
(defn- strip-nils [m] m)

(defn sanitize [m]
  (as-> m $
    normalize-keys
    strip-nils))
        `,
      }]);
      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("normalize-keys");
      expect(dead).not.toContain("strip-nils");
    });
  });

  describe("in-file defn references (user-defined HOFs and value positions)", () => {
    it("emits edges for fns passed to user-defined HOFs", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- my-hof [f coll]
  (map f coll))

(defn- handler [x] x)

(defn run [items]
  (my-hof handler items))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "run").map((c) => c.callee));
      expect(callees).toContain("my-hof");
      expect(callees).toContain("handler"); // passed as value, but known defn
    });

    it("emits edges for fn refs in map literal values", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- home-handler [req] req)
(defn- about-handler [req] req)

(defn build-routes []
  {:home home-handler
   :about about-handler})
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "build-routes").map((c) => c.callee));
      expect(callees).toContain("home-handler");
      expect(callees).toContain("about-handler");
    });

    it("emits edges for fn refs in def value expressions", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(ns myapp.core)

(defn- my-handler [req] req)

(def handler my-handler)
        `,
      }]);
      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("my-handler");
    });

    it("emits edges for fn refs in registration-style calls", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- event-handler [_] nil)

(defn init []
  (reg-event-fx :app/started event-handler))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "init").map((c) => c.callee));
      expect(callees).toContain("reg-event-fx");
      expect(callees).toContain("event-handler");
    });

    it("does not emit in-file ref edges for locals that don't match any defn", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn handler [req]
  (let [user-id (get req :id)]
    (process user-id)))
        `,
      }]);
      const callees = new Set(graph.calls.filter((c) => c.caller === "handler").map((c) => c.callee));
      expect(callees).toContain("get");
      expect(callees).toContain("process");
      expect(callees).not.toContain("user-id"); // local, no matching defn
      expect(callees).not.toContain("req");     // param, no matching defn
    });
  });

  describe("definterface", () => {
    it("registers interface name and methods", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(definterface IShape
  (area [])
  (perimeter []))
        `,
      }]);
      const names = new Set(graph.defines.map((d) => d.name));
      expect(names).toContain("IShape");
      expect(names).toContain("area");
      expect(names).toContain("perimeter");
    });
  });

  describe("dead-code integration (dispatch patterns)", () => {
    it("does not flag helpers used only inside defrecord methods as dead", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defprotocol Store
  (fetch [this k]))

(defn- lookup [k] k)

(defrecord MemStore [data]
  Store
  (fetch [_ k] (lookup k)))
        `,
      }]);

      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("lookup");
    });

    it("does not flag helpers used only as HOF args as dead", async () => {
      const graph = await extractGraph([{
        path: "core.clj",
        content: `
(defn- unqualify-keys [m] m)

(defn execute-query [db sql]
  (mapv unqualify-keys (pg-execute db sql)))
        `,
      }]);

      const { deadCode } = await import("../../src/graph/native-analyses.js");
      const dead = deadCode(graph);
      expect(dead).not.toContain("unqualify-keys");
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
