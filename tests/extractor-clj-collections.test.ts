import { describe, it, expect } from "vitest";
import { extractGraph } from "../src/graph/extractor.js";

describe("extractor: Clojure calls in collection types", () => {
  it("extracts calls inside vec_lit (let bindings)", async () => {
    const graph = await extractGraph([{
      path: "core.clj",
      content: `
(defn handler [req]
  (let [result (process req)]
    (format result)))
      `,
    }]);

    const callees = graph.calls.filter((c) => c.caller === "handler").map((c) => c.callee);
    expect(callees).toContain("process");
    expect(callees).toContain("format");
  });

  it("extracts calls inside map_lit", async () => {
    const graph = await extractGraph([{
      path: "core.clj",
      content: `
(defn build [x]
  {:result (compute x)
   :name (format x)})
      `,
    }]);

    const callees = graph.calls.filter((c) => c.caller === "build").map((c) => c.callee);
    expect(callees).toContain("compute");
    expect(callees).toContain("format");
  });

  it("extracts calls inside set_lit", async () => {
    const graph = await extractGraph([{
      path: "core.clj",
      content: `
(defn choices []
  #{(option-a) (option-b)})
      `,
    }]);

    const callees = graph.calls.filter((c) => c.caller === "choices").map((c) => c.callee);
    expect(callees).toContain("option-a");
    expect(callees).toContain("option-b");
  });
});
