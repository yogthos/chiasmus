# Giving LLMs a Formal Reasoning Engine for Code Analysis

LLM coding assistants are remarkably capable at writing code, but they have a fundamental weakness when it comes to *understanding* existing codebases: they reason about code structure by grepping through source files and mentally reconstructing call chains. This approach works for simple questions but falls apart for transitive ones — "can user input reach this SQL query through any chain of calls?" or "what's all the dead code in this module?" These are questions that require exhaustive structural analysis, not pattern matching.

[Chiasmus](https://github.com/yogthos/chiasmus) is an MCP server that addresses this by giving LLMs access to formal reasoning engines — Z3 for constraint solving and Tau Prolog for logic programming — along with tree-sitter-based source code parsing. The combination lets an LLM load a codebase into a structured representation and answer questions about it with mathematical certainty, using a fraction of the tokens that grepping would require.

The project is grounded in the neurosymbolic AI paradigm described by [Sheth, Roy, and Gaur](https://doi.org/10.1109/MIS.2023.3268724) — the idea that AI systems benefit from combining neural networks (perception, language understanding) with symbolic knowledge-based approaches (reasoning, verification). LLMs are excellent at understanding what you're asking and generating plausible code, but they lack the ability to *prove* properties about that code. Symbolic solvers have that ability but can't understand natural language or navigate a codebase. Chiasmus bridges the two: the LLM handles perception (parsing your question, understanding context, filling templates), while the solvers handle cognition (exhaustive graph traversal, constraint satisfaction, logical inference).

## The Problem with Grepping Through Source

When an LLM assistant needs to answer "what's the blast radius of changing `lintSpec`?", here's what typically happens:

```
Step 1: grep lintSpec src/**/*.ts
  → found in engine.ts (lintLoop) and mcp-server.ts (handleLint)

Step 2: grep lintLoop src/**/*.ts
  → called from solve() at lines 75 and 87

Step 3: grep handleSolve src/**/*.ts
  → called from createChiasmusServer switch...
```

Three rounds of tool calls, each consuming tokens for both the query and the response. At each step, the LLM has to reason about what it found and decide what to grep next. And after all that, it's still only traced *part* of the chain — it missed paths through `correctionLoop`, `runAnalysis`, and several other transitive callers.

This isn't a failure of the LLM. It's a fundamental limitation of the approach. Grep finds string matches. Structural questions about code — reachability, dead code, cycles, impact analysis — require graph traversal, which grep cannot do.

## How Chiasmus Works: Tree-sitter → Prolog → Formal Queries

Chiasmus takes a different approach. Instead of searching through text, it:

1. **Parses source files with tree-sitter** into typed ASTs
2. **Walks the ASTs** to extract structural facts: function definitions, call relationships, imports, exports
3. **Serializes these as Prolog facts** — a declarative representation of the call graph
4. **Runs formal queries** via the Prolog solver to answer structural questions

### Step 1: Tree-sitter Parsing

Tree-sitter is an incremental parsing library that produces concrete syntax trees. Unlike regex-based tools, it understands language grammar — it knows that `foo()` in `function bar() { foo(); }` is a call from `bar` to `foo`, not just a string that contains "foo".

Chiasmus currently supports TypeScript, JavaScript, and Clojure (with a hybrid architecture: native tree-sitter for TS/JS, WASM for Clojure). When you pass source files to `chiasmus_graph`, the parser:

- Identifies function declarations (`function_declaration`, `arrow_function`, `method_definition` in TS/JS; `defn`, `defn-` in Clojure)
- Resolves call expressions (`call_expression` → callee name, handling `obj.method()` → `method`, `this.bar()` → `bar`, `db/query` → `query`)
- Tracks scope (which function is the *caller* for each call site)
- Extracts imports and exports for cross-file resolution

### Step 2: Prolog Fact Generation

The extracted relationships become Prolog facts:

```prolog
defines('src/formalize/validate.ts', lintSpec, function, 16).
defines('src/formalize/engine.ts', lintLoop, function, 208).
defines('src/formalize/engine.ts', solve, function, 64).
defines('src/mcp-server.ts', handleLint, function, 527).

calls(lintLoop, lintSpec).
calls(solve, lintLoop).
calls(handleLint, lintSpec).
calls(handleSolve, solve).
calls(correctionLoop, solve).

exports('src/formalize/validate.ts', lintSpec).
```

This is a complete, queryable representation of the call graph. Every function definition, every call edge, every import relationship — all encoded as ground facts that a Prolog engine can reason over.

### Step 3: Built-in Rules for Structural Analysis

Alongside the facts, Chiasmus appends rules that enable the kinds of queries LLMs actually need. The most important is cycle-safe transitive reachability:

```prolog
reaches(A, B) :- reaches(A, B, [A]).
reaches(A, B, _) :- calls(A, B).
reaches(A, B, Visited) :-
    calls(A, Mid),
    \+ member(Mid, Visited),
    reaches(Mid, B, [Mid|Visited]).
```

This rule says: A reaches B if A calls B directly, or if A calls some intermediate function Mid (not yet visited) that reaches B. The visited list prevents infinite loops on cyclic call graphs — a real concern in any codebase with mutual recursion or event loops.

With this single rule, the solver can answer transitive reachability over the entire call graph. No iterative grepping. No manual chain reconstruction. One query, deterministic answer.

### Step 4: Query Execution

Now the same "blast radius" question becomes a single tool call:

```
chiasmus_graph analysis="impact" target="lintSpec"
→ ["lintLoop", "handleLint", "solve", "correctionLoop",
   "handleVerify", "handleSolve", "handleGraph",
   "createChiasmusServer", "runAnalysis", "runAnalysisFromGraph"]
```

Ten affected functions, found exhaustively, in one call. The Prolog solver traversed every path in the call graph and collected every function that transitively calls `lintSpec`. The LLM didn't need to reason about the graph structure at all — it asked a question and got a complete answer.

## What This Makes Possible That Grep Cannot

The real value isn't just efficiency — it's *correctness*. There are questions that grep fundamentally cannot answer, regardless of how many rounds you run:

### Transitive Reachability

"Can user input reach the database query?" This requires proving that a path exists (or doesn't exist) through potentially dozens of intermediate functions across multiple files. Grep can find direct callers, but tracing the full transitive closure requires the LLM to make decisions at each step about which paths to follow. It will miss branches. It will run out of context. It will give you a best guess, not a proof.

With Chiasmus:

```
chiasmus_graph analysis="reachability" from="handleRequest" to="dbQuery"
→ { reachable: true }

chiasmus_graph analysis="path" from="handleRequest" to="dbQuery"
→ { paths: ["[handleRequest,validate,processData,dbQuery]"] }
```

The solver explores every possible path. If it says "not reachable", that's a proof by exhaustion — there is no chain of calls from A to B in the entire graph.

### Dead Code Detection

"Which functions are never called?" To answer this with grep, you'd need to check every function definition against every call site in the codebase. For a project with 100 functions, that's 100 grep calls minimum — and you'd still miss transitive dead code (functions only called by other dead functions).

With Chiasmus:

```
chiasmus_graph analysis="dead-code"
→ ["unusedHelper", "legacyParser", "deprecatedValidator"]
```

One call. The Prolog rule is simple:

```prolog
dead(Name) :-
    defines(_, Name, function, _),
    \+ calls(_, Name),
    \+ entry_point(Name).
```

A function is dead if it's defined, nobody calls it, and it's not an entry point. The solver checks this against every function in the graph exhaustively.

### Cycle Detection

"Are there circular call dependencies?" Grep cannot detect cycles at all — it's a graph-theoretic property that requires traversal.

```
chiasmus_graph analysis="cycles"
→ ["eventHandler", "processQueue", "dispatchEvent"]
```

The solver finds all nodes that can reach themselves through any chain of calls.

### Impact Analysis

"What breaks if I change this function?" This is reverse transitive reachability — find everything that transitively depends on the target. Grep gives you direct callers. Impact analysis gives you the full blast radius.

```
chiasmus_graph analysis="impact" target="validate"
→ ["handleRequest", "batchProcessor", "main", "testHarness"]
```

## Token Economics

Beyond correctness, there's a practical cost argument. Each grep call consumes tokens for the query, the response (which includes matching lines plus context), and the LLM's reasoning about what to do next. For a transitive question requiring N hops through the call graph:

- **Grep approach**: ~N tool calls × (query tokens + response tokens + reasoning tokens). For a 5-hop chain, this might be 5 calls × ~500 tokens = ~2,500 tokens, assuming the LLM doesn't go down wrong paths (which it will).
- **Chiasmus approach**: 1 tool call × ~200 tokens (small JSON response). The heavy computation happens in the Prolog solver, which runs locally and doesn't consume API tokens.

The savings compound with codebase size. In a 500-function project, dead code detection via grep would require hundreds of calls. Via Chiasmus, it's still one call.

## Beyond Code: Mermaid Diagrams and Formal Verification

The same architecture handles more than source code. Chiasmus can parse Mermaid diagrams directly into Prolog facts:

```
chiasmus_verify solver="prolog" format="mermaid"
  input="stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : submit
    Processing --> Review : complete
    Review --> Approved : approve
    Review --> Processing : revise
    Approved --> [*]"
  query="can_reach(idle, approved)."
→ { status: "success", answers: [{}] }
```

An architecture diagram, a state machine from a design doc, a workflow from a ticket — if it's expressed as a Mermaid graph, you can formally verify properties of it. "Can every state reach the terminal state?" "Are there dead-end states?" "Is there a cycle between review and processing?" These become one-line queries against a proven solver.

And for constraint problems beyond graphs — access control conflicts, configuration equivalence, dependency resolution — Chiasmus provides Z3, an SMT solver that can prove properties over combinatorial spaces. "Can these RBAC rules ever produce contradictory allow/deny decisions?" isn't a question you can grep for. It requires exploring every possible combination of roles, actions, and resources. Z3 does this exhaustively and returns either a proof of consistency or a concrete counterexample.

## The Neurosymbolic Advantage

The neurosymbolic AI literature classifies systems by how tightly they couple neural and symbolic components. Chiasmus operates as what Sheth et al. call a Category 2(a) "federated pipeline" — the LLM identifies what formal analysis is needed and delegates to symbolic solvers for execution. But it pushes toward Category 2(b) in several ways:

- **Enriched feedback loops**: When the solver returns UNSAT, the unsat core (which specific assertions conflict) feeds back to the LLM as structured guidance, not just an opaque error. This is the symbolic system informing the neural system's next action.
- **Derivation traces**: When Prolog proves a query, the trace of which rules fired gives the LLM (and the developer) an explanation of *why* the answer holds — directly addressing the explainability gap that the neurosymbolic literature highlights as a key weakness of pure neural approaches.
- **Template learning**: When a verification pattern proves useful, it can be extracted into a reusable template. The symbolic structure (skeleton with typed slots) is learned from successful neural-symbolic interactions, creating a feedback loop where the system improves with use.

The practical consequence: when an LLM uses Chiasmus to answer "is there dead code?", the answer isn't a probabilistic guess based on pattern matching over training data. It's a logical proof by exhaustion over a formally complete representation of the call graph. The neural component understood the question. The symbolic component proved the answer.

## The Architecture

Chiasmus runs as an MCP (Model Context Protocol) server — a standard protocol for giving LLMs access to external tools. Any MCP-compatible client (Claude Code, Cursor, etc.) can use it. Setup is one command:

```bash
claude mcp add chiasmus -- npx -y chiasmus
```

The server exposes nine tools:

- **chiasmus_graph** — tree-sitter call graph analysis (callers, callees, reachability, dead-code, cycles, path, impact)
- **chiasmus_verify** — submit formal logic to Z3 or Prolog solvers directly
- **chiasmus_craft** — create reusable verification templates
- **chiasmus_formalize** — find the right template for a problem
- **chiasmus_skills** — search the template library
- **chiasmus_solve** — end-to-end autonomous verification
- **chiasmus_learn** — extract templates from verified solutions
- **chiasmus_lint** — structural validation of formal specs

No API keys required for the core workflow. The LLM calling Chiasmus already has the context to fill templates and interpret results — it just needs the formal reasoning engine to run the actual computation.

## What Changes for the Developer

From the developer's perspective, the experience is subtle but significant. You ask your coding assistant a structural question, and instead of watching it grep through files for 30 seconds, it answers immediately with a complete, provably correct result. "What calls this function?" comes back with every transitive caller in the graph. "Is there dead code?" comes back with a definitive list, not "I checked a few files and didn't find any callers."

The LLM spends fewer tokens on exploration and more on the work you actually asked for. And when it tells you something about your code's structure, you can trust it — because the answer came from a solver, not a guess.

The project is open source at [github.com/yogthos/chiasmus](https://github.com/yogthos/chiasmus).
