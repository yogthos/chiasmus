[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/yogthos-chiasmus-badge.png)](https://mseep.ai/app/yogthos-chiasmus)

# Chiasmus

MCP server that gives LLMs access to formal verification via Z3 (SMT solver) and SWI-Prolog (via `prolog-wasm-full`, includes `library(clpfd)`), plus tree-sitter-based source code analysis. Translates natural language problems into formal logic using a template-based pipeline, verifies results with mathematical certainty, and analyzes call graphs for reachability, dead code, and impact analysis.

### Example use cases

- **"Can our RBAC rules ever conflict?"** → Z3 finds the exact role/action/resource triple where allow and deny both fire
- **"Find compatible package versions"** → Z3 solves dependency constraints with incompatibility rules, returns a valid assignment or proves none exists
- **"Can user input reach the database?"** → Prolog traces all paths through the call graph, flags taint flows to sensitive sinks
- **"Are our frontend and backend validations consistent?"** → Z3 finds concrete inputs that pass one but fail the other (e.g. age=15 passes frontend min=13 but fails backend min=18)
- **"Does our workflow have dead-end or unreachable states?"** → Prolog checks reachability from the initial state, identifies orphaned and terminal nodes
- **"What's the dead code in this module?"** → tree-sitter parses source files, Prolog finds functions unreachable from any entry point
- **"What breaks if I change this function?"** → call graph impact analysis shows all transitive callers
- **"Do a full code review of these files"** → `chiasmus_review` returns a phased recipe of graph analyses + verification templates, and you execute it step-by-step

## Setup

```bash
npm install -g chiasmus
```

### Claude Code

```bash
claude mcp add chiasmus -- npx -y chiasmus
```

Or add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "chiasmus": {
      "command": "npx",
      "args": ["-y", "chiasmus"]
    }
  }
}
```

### Crush

Add to `crush.json`:

```json
{
  "mcp": {
    "chiasmus": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "chiasmus"]
    }
  }
}
```

### OpenCode

Add to `opencode.json`:

```json
{
  "mcp": {
    "chiasmus": {
      "type": "local",
      "command": ["npx", "-y", "chiasmus"]
    }
  }
}
```

## Tools

**`chiasmus_verify`** — Submit raw SMT-LIB or Prolog, get a verified result. Z3 UNSAT results include an `unsatCore` showing which assertions conflict. Prolog supports `explain=true` for derivation traces showing which rules fired.

```
chiasmus_verify solver="z3" input="
  (declare-const x Int)
  (assert (! (> x 10) :named gt10))
  (assert (! (< x 5) :named lt5))
"
→ { status: "unsat", unsatCore: ["gt10", "lt5"] }
```

```
chiasmus_verify solver="prolog"
  input="parent(tom, bob). parent(bob, ann). ancestor(X,Y) :- parent(X,Y). ancestor(X,Y) :- parent(X,Z), ancestor(Z,Y)."
  query="ancestor(tom, Who)."
  explain=true
→ { status: "success", answers: [...], trace: ["ancestor(tom,bob)", "ancestor(bob,ann)", "ancestor(tom,ann)"] }
```

**`chiasmus_verify`** also accepts `format="mermaid"` with `solver="prolog"` to parse Mermaid flowcharts and state diagrams directly into Prolog facts:

```
chiasmus_verify solver="prolog" format="mermaid"
  input="graph TD\n  UserInput --> Validator\n  Validator --> DB\n  Validator --> Logger"
  query="reaches(userinput, db)."
→ { status: "success", answers: [{}] }

chiasmus_verify solver="prolog" format="mermaid"
  input="stateDiagram-v2\n  Idle --> Active : start\n  Active --> Done : finish"
  query="can_reach(idle, done)."
→ { status: "success", answers: [{}] }
```

**`chiasmus_graph`** — Analyze source code call graphs via tree-sitter + Prolog. Parses source files, extracts cross-module call graphs, runs formal analyses.

Built-in language support: **TypeScript**, **JavaScript**, **Python**, **Go**, **Clojure/ClojureScript**. Additional languages can be added via [custom adapters](#custom-language-adapters).

```
chiasmus_graph files=["src/server.ts", "src/db.ts"] analysis="callers" target="query"
→ { analysis: "callers", result: ["handleRequest"] }

chiasmus_graph files=["src/**/*.ts"] analysis="dead-code"
→ { analysis: "dead-code", result: ["unusedHelper", "legacyParser"] }

chiasmus_graph files=["app.py", "db.py"] analysis="reachability" from="handle" to="connect"
→ { analysis: "reachability", result: { reachable: true } }

chiasmus_graph files=["main.go", "handler.go"] analysis="impact" target="Query"
→ { analysis: "impact", result: ["Handle", "main"] }
```

Analyses: `summary`, `callers`, `callees`, `reachability`, `dead-code`, `cycles`, `path`, `impact`, `layer-violation`, `communities`, `hubs`, `bridges`, `surprises`, `diff`, `entry-points`, `facts`.

Reachability-heavy analyses (`cycles`, `reachability`, `path`, `impact`, `dead-code`, `callers`, `callees`) run on native O(V+E) graph algorithms and scale to codebases with thousands of functions. `communities` uses Louvain; `bridges` uses exact betweenness centrality. The `facts` analysis emits raw Prolog for use with `chiasmus_verify`, capped at 10 MB — above that limit the result is `{ error, size, limit }` rather than a program string, so narrow the file set or call a specific analysis directly. Opt in to `include_insights=true` on `facts` to also emit `community/2`, `cohesion/2`, `hub/2`, `bridge/2` predicates.

TS/JS calls also carry qualified-name hints when the receiver's class can be inferred (`CallsFact.calleeQN = "Class.method"`), and imports are resolved through `tsconfig.json` path aliases and the batch's file layout (`ImportsFact.resolved = "<repo-relative path>"`). Both surface as additive Prolog facts — `calls_qn/3` and `imports_resolved/3` — so back-compat queries over `calls/2` and `imports/3` keep working.

### Persistent cache and PR diff

Pass `cache=true` on `chiasmus_graph` to enable a per-file content-hash cache — unchanged files skip re-parsing across calls. On a 42-file TypeScript repo, warm hits run at ~2.5ms vs ~170ms cold (60× speedup). Cache lives under `$CHIASMUS_CACHE_DIR` (default `~/.cache/chiasmus`) with an LRU budget per repo.

```
chiasmus_graph files=[...] analysis="summary" cache=true save_snapshot="main"
→ extracts + saves the current graph as the "main" baseline

# After branch changes:
chiasmus_graph files=[...] analysis="diff" against="main" cache=true
→ { addedNodes, removedNodes, addedEdges, removedEdges, summary }
```

`chiasmus_review` accepts `delta_against="<snapshot>"` — when set, a phase 0 diffs against the snapshot, impact-checks removed symbols, and scopes later phases to what the PR actually changed.

**`chiasmus_map`** — Pre-built codebase map for agents to consult **before** bulk file reads. Reuses the same tree-sitter extraction + cache as `chiasmus_graph`; returns a compact outline so an LLM can answer "what's in this repo" / "what does this file expose" / "where is X defined" without opening source.

```
chiasmus_map files=["src/**/*.ts"]
→ markdown outline: per-file headlines, exports with signatures,
  token estimates, leading doc comments

chiasmus_map files=[...] mode="file" path="src/server.ts" format="json"
→ { exports, imports grouped by source, all top-level symbols }

chiasmus_map files=[...] mode="symbol" name="handleRequest"
→ { defines: [{file, line, signature}], callers, callees }
```

Modes: `overview` (default), `file`, `symbol`. Output: `markdown` (default) or `json`. `include` globs and `max_exports` (clamped to ≥0) scope the overview. `cache=true` reuses the shared per-file cache.

**`chiasmus_skills`** — Search the template library. Ships with 8 starter templates covering authorization, configuration, dependency resolution, validation, rule inference, and graph reachability. By-name lookups include related template suggestions.

**`chiasmus_formalize`** — Find the best template for a problem, get slot-filling instructions plus suggestions for related verification checks. Fill the slots using your context, then call `chiasmus_verify`.

**`chiasmus_solve`** — End-to-end: selects template, fills slots via LLM, runs lint and correction loops with enriched feedback (unsat cores, structured error classification), returns a verified result. Optional — the same result is achieved by using `chiasmus_formalize` → fill slots → `chiasmus_verify`, which is the recommended workflow since the calling LLM has full conversation context.

**`chiasmus_craft`** — Create a new template and add it to the skill library. The calling LLM designs the template — no API key needed. Describe a problem type, then submit a skeleton with `{{SLOT:name}}` markers, slot definitions, and normalization recipes. Validates slot/skeleton consistency and name uniqueness. Optionally tests the example through the solver.

```
chiasmus_craft name="api-rate-limit" domain="configuration" solver="z3"
  signature="Check if rate limit configs across services are consistent"
  skeleton="{{SLOT:declarations}}\n(assert (not (= {{SLOT:limit_a}} {{SLOT:limit_b}})))"
  slots=[{name: "declarations", ...}, {name: "limit_a", ...}, {name: "limit_b", ...}]
  normalizations=[{source: "YAML config", transform: "Map rate limits to Int constants"}]
→ { created: true, template: "api-rate-limit", slots: 3 }
```

After creation, the template appears in `chiasmus_skills` searches and `chiasmus_formalize`.

**`chiasmus_review`** — Returns a phased code-review recipe: which chiasmus tools and templates to run, in what order, and what to look for. No side effects — pure scaffolding. Execute phases sequentially using the named tools, then produce a final report per the `reporting` section.

```
chiasmus_review files=["src/handler.ts", "src/db.ts"] focus="all"
→ {
    phases: [
      { phase: "1. Structural overview", actions: [{tool: "chiasmus_graph", args: {analysis: "summary"}, interpret: "..."}] },
      { phase: "2. Architecture health", actions: [dead-code, cycles, layer-violation] },
      { phase: "3. Security — data flow and taint", actions: [facts + chiasmus_formalize taint-propagation] },
      { phase: "4. Resource safety", actions: [association-rule-check] },
      { phase: "5. Authorization", actions: [policy-contradiction] },
      { phase: "6. Correctness — invariants, boundaries, state machines", actions: [...] },
      { phase: "7. Impact analysis on flagged functions", actions: [chiasmus_graph impact] },
    ],
    suggestedTemplates: [...],
    reporting: { format: "Numbered issue list with severity", severityLevels: ["CRITICAL","HIGH","MEDIUM","LOW","INFO"] }
  }
```

Focus modes subset the phases: `all` (default, 7 phases), `quick` (overview + architecture), `architecture` (structural defects + impact), `security` (taint + resource pairing + auth), `correctness` (invariants + boundaries + state machines).

Each action carries an `interpret` field describing how to score the result. After all phases, emit a numbered issue list with severity labels and file:line references.

**`chiasmus_search`** — Semantic code search over a set of files. Finds functions and methods whose *meaning* matches a natural-language query (e.g. "where do we refresh OAuth tokens", "rate-limit logic"). Uses embeddings + cosine similarity over callable defines; returns a ranked list with `{name, file, line, signature, leadingDoc, score}`.

```
chiasmus_search query="refresh OAuth tokens" files=["src/**/*.ts"] top_k=5
→ { hits: [
    { name: "refreshAccessToken", file: "src/auth/token.ts", line: 42, score: 0.78, ... },
    { name: "rotateSession", file: "src/auth/session.ts", line: 118, score: 0.71, ... },
    ...
  ] }
```

Opt-in: needs an embedding provider via env (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`). Override the model with `CHIASMUS_EMBED_MODEL` (default `text-embedding-3-small`), base URL with `CHIASMUS_EMBED_URL`, and dimension with `CHIASMUS_EMBED_DIM`. Embeddings are cached by content SHA-256 under `$CHIASMUS_HOME/embeddings` — unchanged code is not re-embedded.

**`chiasmus_learn`** — Extract a reusable template from a verified solution. Candidates get promoted after 3+ successful reuses.

**`chiasmus_lint`** — Fast structural validation of specs without running the solver.

## Recommended Workflow

The calling LLM (GLM, GPT, etc.) drives the process — no API key needed:

1. `chiasmus_formalize problem="Can our RBAC rules ever conflict?"` → get template + slot instructions
2. Fill the template slots using your knowledge of the user's codebase
3. `chiasmus_verify solver="z3" input="(filled spec)"` → get verified result
4. If error → read the error, fix the spec, call `chiasmus_verify` again

## When to Use

Use a solver when the LLM alone can't guarantee correctness:

- **"Does this hold for ALL inputs?"** — solvers prove universally, LLMs just check examples
- **"Do these rules ever conflict?"** — contradiction detection over combinatorial spaces
- **"Can X reach Y through any path?"** — transitive closure / reachability
- **Access control, configs, dependencies** — where correctness is non-negotiable

Use `chiasmus_graph` when you need structural reasoning about code:

- **"What calls this function?"** — impact analysis before refactoring
- **"What's dead code?"** — find functions unreachable from entry points
- **"Can user input reach this SQL query?"** — taint analysis via call graph reachability
- **"What breaks if I change X?"** — blast radius via reverse reachability
- **"Are there circular dependencies?"** — cycle detection in call graphs

## Why `chiasmus_graph` over grep

When an LLM needs to understand code structure, it typically greps for function names and manually traces call chains. This works for direct references but breaks down for transitive questions. Here's a real comparison using chiasmus's own codebase:

**Question: "What's the blast radius of changing `lintSpec`?"**

With grep, this takes multiple rounds — first find direct callers, then callers of those callers, reconstructing the chain manually:

```
grep lintSpec src/**/*.ts     → found in engine.ts (lintLoop) and mcp-server.ts (handleLint)
grep lintLoop src/**/*.ts     → called from solve() at lines 75 and 87
grep handleSolve src/**/*.ts  → called from createChiasmusServer switch...
```

Three rounds of grep, manual reasoning at each step, and you've still only traced part of the chain. With `chiasmus_graph`, one call gives the complete transitive answer:

```
chiasmus_graph analysis="impact" target="lintSpec"
→ ["lintLoop", "handleLint", "solve", "correctionLoop",
   "handleVerify", "handleSolve", "handleGraph",
   "createChiasmusServer", "runAnalysis", "runAnalysisFromGraph"]
```

10 affected functions found in a single call — including paths through `correctionLoop` and `runAnalysis` that the grep approach missed entirely.

The same applies to other structural questions:

| Question | Grep | chiasmus_graph |
|----------|------|----------------|
| Impact of changing X | Multiple greps + manual trace; misses transitive paths | 1 call, complete transitive chain |
| Dead code detection | Grep every function name against all call sites — impractical | 1 call, definitive answer |
| Can A reach B? | Manually reconstruct call chain across files | 1 call, true/false |
| Call chain A→B | Multiple greps, mentally reconstruct path | 1 call, exact chain e.g. `[handleSolve,solve,lintLoop,lintSpec]` |

The key difference: grep finds string matches, `chiasmus_graph` answers structural questions. Transitive reachability, dead code, and impact analysis are formally impossible with grep alone.

## Custom Language Adapters

Add tree-sitter support for any language by publishing an npm package named `chiasmus-adapter-<language>`. Chiasmus auto-discovers these at startup.

```ts
// chiasmus-adapter-rust/index.ts
import type { LanguageAdapter } from "chiasmus/graph";

const adapter: LanguageAdapter = {
  language: "rust",
  extensions: [".rs"],
  grammar: { package: "tree-sitter-rust" },
  extract(rootNode, filePath) {
    const defines = [];
    const calls = [];
    // Walk the tree-sitter AST and populate defines, calls, imports, etc.
    // ... your language-specific extraction logic ...
    return { defines, calls, imports: [], exports: [], contains: [] };
  },
};

export default adapter;
```

Install alongside chiasmus and enable adapter discovery in `~/.chiasmus/config.json`:

```bash
npm install chiasmus-adapter-rust
```

```json
{
  "adapterDiscovery": true
}
```

Adapter discovery is **off by default** to keep startup fast. Enable it when you have custom adapters installed.

### searchPaths

An adapter can export `searchPaths` to point to directories containing additional adapter modules (`.js`/`.mjs` files). This is useful for loading adapters from non-standard locations:

```ts
export default {
  language: "rust",
  extensions: [".rs"],
  grammar: { package: "tree-sitter-rust" },
  extract(rootNode, filePath) { /* ... */ },
  searchPaths: ["/shared/company-adapters"],
};
```

### Adapter interface

| Field | Type | Description |
|-------|------|-------------|
| `language` | `string` | Language identifier (e.g., `"rust"`) |
| `extensions` | `string[]` | File extensions (e.g., `[".rs"]`) |
| `grammar` | `object` | Tree-sitter grammar: `{ package, moduleExport? }` for native or `{ package, wasmFile, wasm: true }` for WASM |
| `extract` | `(rootNode, filePath) => CodeGraph` | Walks the AST and returns `{ defines, calls, imports, exports, contains }` |
| `searchPaths` | `string[]` (optional) | Additional directories to scan for adapter modules |

Built-in languages always take precedence over adapters with the same extensions.

## Library Usage

Chiasmus can be used as a library in any Node.js project:

```bash
npm install chiasmus
```

### Quick Start

```ts
import { SolverSession, lintSpec, SkillLibrary, FormalizationEngine } from "chiasmus";
```

Or import from specific subpaths:

```ts
import { createZ3Solver, createPrologSolver } from "chiasmus/solvers";
import { extractGraph, runAnalysis } from "chiasmus/graph";
import { lintSpec, FormalizationEngine } from "chiasmus/formalize";
import { SkillLibrary, SkillLearner } from "chiasmus/skills";
import { createLLMFromEnv } from "chiasmus/llm";
```

### Solvers

```ts
import { SolverSession } from "chiasmus/solvers";

const session = await SolverSession.create("z3");
try {
  const result = await session.solve({
    type: "z3",
    smtlib: `(declare-const x Int) (assert (> x 5))`,
  });
  if (result.status === "sat") {
    console.log("Satisfiable:", result.model);
  }
} finally {
  session.dispose();
}
```

### Graph Analysis

```ts
import { extractGraph, runAnalysis } from "chiasmus/graph";

const result = await runAnalysis(
  ["src/server.ts", "src/db.ts"],
  { analysis: "dead-code" }
);
console.log(result.result);
```

### Lint & Validation

```ts
import { lintSpec } from "chiasmus/formalize";

const { spec, fixes, errors } = lintSpec(rawSpec, "z3");
if (errors.length > 0) {
  console.error("Lint errors:", errors);
}
```

### Skill Library

```ts
import { SkillLibrary } from "chiasmus/skills";
import { join } from "node:path";
import { homedir } from "node:os";

const library = await SkillLibrary.create(join(homedir(), ".chiasmus"));
const results = library.search("access control policy conflict");
console.log(results);
library.close();
```

### Exports

| Subpath | Exports |
|---------|---------|
| `chiasmus` | All public APIs (barrel export) |
| `chiasmus/solvers` | `SolverSession`, `createZ3Solver`, `createPrologSolver`, `correctionLoop`, solver types |
| `chiasmus/graph` | `extractGraph`, `runAnalysis`, `runAnalysisFromGraph`, `buildFactsResult`, `graphToProlog`, `parseMermaid`, `detectCommunities`, `detectHubs`, `detectBridges`, `detectSurprisingConnections`, `detectEntryPoints`, `graphDiff`, `saveSnapshot`/`loadSnapshot`/`listSnapshots`, cache APIs, adapter registry, graph types |
| `chiasmus/formalize` | `lintSpec`, `classifyFeedback`, `extractPrologQuery`, `FormalizationEngine`, result types |
| `chiasmus/skills` | `SkillLibrary`, `SkillLearner`, `craftTemplate`, `validateTemplate`, skill types |
| `chiasmus/llm` | `createLLMFromEnv`, `AnthropicAdapter`, `OpenAICompatibleAdapter`, LLM types |
| `chiasmus/mcp` | `createChiasmusServer`, `getChiasmusHome` |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHIASMUS_HOME` | `~/.chiasmus/` | Database, skill storage, and config |
| `CHIASMUS_CACHE_DIR` | `~/.cache/chiasmus` | Per-file extraction cache + graph snapshots (when `cache=true`) |
| `CHIASMUS_CACHE_MAX_PER_REPO` | `67108864` (64 MB) | Per-repo cache byte budget — LRU eviction above this |
| `ANTHROPIC_API_KEY` | — | Optional: Anthropic provider for autonomous mode |
| `DEEPSEEK_API_KEY` | — | Optional: DeepSeek provider for autonomous mode |
| `OPENAI_API_KEY` | — | Optional: OpenAI provider for autonomous mode |
| `CHIASMUS_API_URL` | per provider | Override API base URL (e.g. for local models via Ollama) |
| `CHIASMUS_MODEL` | per provider | Override model name |

Providers are checked in order: Anthropic → DeepSeek → OpenAI. Only one key is needed for autonomous mode (`chiasmus_solve`, `chiasmus_learn`). When used from Claude Code, Crush, or OpenCode, no API key is needed — the calling LLM handles template filling directly.

### `~/.chiasmus/config.json`

| Key | Default | Purpose |
|-----|---------|---------|
| `adapterDiscovery` | `false` | Scan `node_modules` for `chiasmus-adapter-*` packages at startup |

## License

Apache-2.0
