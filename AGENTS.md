# AGENTS.md — Chiasmus

## Project Overview

Chiasmus is an MCP (Model Context Protocol) server that gives LLMs access to formal verification via **Z3** (SMT solver) and **SWI-Prolog** (via `prolog-wasm-full`, including `library(clpfd)`). It also provides tree-sitter-based source code call graph analysis. The server translates natural language problems into formal logic using a template-based pipeline, verifies results with mathematical certainty, and analyzes call graphs for reachability, dead code, and impact analysis.

- **Language**: TypeScript (strict mode, ESM)
- **Runtime**: Node.js ≥20
- **License**: Apache-2.0
- **Package**: npm package `chiasmus`, exposes a CLI binary

## Commands

```bash
pnpm build          # Compile TypeScript (tsc) → dist/
pnpm typecheck      # Type-check only (tsc --noEmit)
pnpm test           # Run tests in watch mode (vitest)
pnpm test:run       # Run tests once (vitest run)
pnpm test:coverage  # Run tests with V8 coverage report
pnpm mcp            # Run MCP server locally via tsx
```

### CI Pipeline

CI runs on push/PR to `main` (`.github/workflows/test.yml`):
1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm test:run`

Tested on Node 22 and 24. Minimum is Node 22 (better-sqlite3 13 requires it; Node 20 went EOL 2026-04-30).

## Code Organization

```
src/
├── mcp-server.ts          # Entry point — MCP server, tool handlers (graph ones in graph/tool-handlers.ts), CLI bootstrap
├── config.ts              # Loads ~/.chiasmus/config.json
├── solvers/
│   ├── types.ts           # SolverType, SolverResult (discriminated union), Solver, SolverInput
│   ├── session.ts         # SolverSession — factory for Z3/Prolog solver instances
│   ├── z3-solver.ts       # Z3 WASM wrapper (z3-solver npm), auto-strips check-sat/get-model
│   ├── prolog-solver.ts   # SWI-Prolog (prolog-wasm-full) wrapper, derivation tracing via assertz
│   └── correction-loop.ts # Bounded repair loop (delegates to repl-sandbox)
├── formalize/
│   ├── engine.ts          # FormalizationEngine — template selection, LLM slot-filling, solve pipeline
│   ├── validate.ts        # lintSpec — structural validation, auto-fixes for SMT-LIB/Prolog
│   └── feedback.ts        # classifyFeedback — converts SolverResult to human-readable feedback
├── skills/
│   ├── types.ts           # SkillTemplate, SlotDef, Normalization, SkillMetadata
│   ├── library.ts         # SkillLibrary — SQLite-backed template storage, BM25 search
│   ├── starters.ts        # 8 built-in starter templates (5 Z3, 3 Prolog)
│   ├── bm25.ts            # BM25 keyword search for template retrieval
│   ├── craft.ts           # craftTemplate — user-created template validation + storage
│   ├── learner.ts         # SkillLearner — LLM-driven template extraction from solutions
│   └── relationships.ts   # Template relationship/suggestion graph
├── graph/
│   ├── types.ts           # CodeGraph, LanguageAdapter, FileNode, Hyperedge, DefinesFact, CallsFact.calleeQN, ImportsFact.resolved, FileTypeInfo
│   ├── parser.ts          # tree-sitter lang registry + sync/async parse for TS/JS/Py/Go/Rust/Clojure/Scheme/Racket/CL
│   ├── extractor.ts       # AST walking + per-language call graph extraction + TS/JS collectTypeInfo
│   ├── extract-sexp.ts    # Scheme/Racket + Common Lisp extraction (scope-aware s-expression walkers)
│   ├── facts.ts           # graphToProlog — CodeGraph → Prolog facts (incl. calls_qn/3, imports_resolved/3)
│   ├── analyses.ts        # runAnalysis — dispatches all graph analyses
│   ├── native-analyses.ts # O(V+E) cycles/reachability/impact/dead-code/callers/callees
│   ├── graph-util.ts      # Shared helpers: buildUndirectedGraph, forEachUndirectedEdge, undirectedDegree
│   ├── community.ts       # Louvain community detection + cohesion score
│   ├── insights.ts        # detectHubs, detectBridges, detectSurprisingConnections
│   ├── diff.ts            # graphDiff — set diff on nodes + (src,tgt) edge keys
│   ├── entry-points.ts    # Heuristic entry-point detection (zero-in-degree exports)
│   ├── cache.ts           # SHA256 per-file cache + LRU eviction + named snapshots (proper-lockfile)
│   ├── tool-handlers.ts   # chiasmus_graph / chiasmus_map handlers (run in the graph child process)
│   ├── child-pool.ts      # GraphChildPool — persistent child process, bounded queue, recycling, SIGKILL stops
│   ├── graph-child.ts     # Child-process entry: runs one job at a time, reports fatal WASM + its own RSS
│   ├── mermaid.ts         # parseMermaid — Mermaid flowcharts/state diagrams → Prolog facts
│   ├── type-env.ts        # TS/JS three-tier type inference + class field/method extraction
│   ├── resolve-calls.ts   # Project-wide QN resolution: inheritance-aware field/method registry
│   ├── tsconfig-aliases.ts # Parses tsconfig.json paths/baseUrl with JSONC + extends chain
│   ├── suffix-index.ts    # Suffix index over batch files for relative import resolution
│   └── adapter-registry.ts # Auto-discovery of chiasmus-adapter-* npm packages
├── search/
│   ├── engine.ts          # buildSearchCorpus + runSearch — cosine-sim code search
│   ├── vector-store.ts    # In-process linear-scan store; serializable
│   ├── embedding-cache.ts # SHA-256-keyed persistent cache, atomic writes
│   └── index.ts           # Module exports
├── llm/
│   ├── types.ts           # LLMAdapter + EmbeddingAdapter interfaces, LLMMessage
│   ├── anthropic.ts       # Anthropic/DeepSeek/OpenAI provider factories (createLLMFromEnv, createEmbeddingFromEnv)
│   ├── openai-compatible.ts # OpenAI-compatible chat + embedding adapters
│   └── mock.ts            # Mock LLM + MockEmbeddingAdapter for testing
tests/                      # Unit tests (mirrors src/ structure)
benchmark/                  # Benchmark problems (5 problems × traditional + chiasmus implementations)
```

## Key Types and Patterns

### SolverResult (discriminated union)

The core result type — always check `status` first:

```typescript
type SolverResult =
  | { status: "sat"; model: Record<string, string> }        // Z3 found satisfying assignment
  | { status: "unsat"; unsatCore?: string[] }                // Z3 proved unsatisfiable
  | { status: "unknown" }                                    // Z3 couldn't determine
  | { status: "success"; answers: PrologAnswer[]; trace?: string[] }  // Prolog query succeeded
  | { status: "error"; error: string }                       // Solver/parse error
```

### SolverInput (discriminated union)

```typescript
type SolverInput =
  | { type: "z3"; smtlib: string }
  | { type: "prolog"; program: string; query: string; explain?: boolean }
```

### LLMAdapter

```typescript
interface LLMAdapter {
  complete(system: string, messages: LLMMessage[]): Promise<string>;
}

interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
  dimension(): number;
}
```

LLM provider priority: `ANTHROPIC_API_KEY` → `DEEPSEEK_API_KEY` → `OPENAI_API_KEY`.

Embedding provider priority (Anthropic has no embeddings): `OPENAI_API_KEY` → `DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY`. Override the model via `CHIASMUS_EMBED_MODEL` (default `text-embedding-3-small`), URL via `CHIASMUS_EMBED_URL`, and dimension via `CHIASMUS_EMBED_DIM`.

## Conventions

### Import Style

- All imports use `.js` extension (ESM with NodeNext module resolution):
  ```typescript
  import { SolverSession } from "./solvers/session.js";
  import type { SolverResult } from "./solvers/types.js";
  ```
- Type-only imports use `import type { ... }`.

### Module System

- **ESM only** (`"type": "module"` in package.json)
- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"` in tsconfig.json
- Source in `src/`, compiled output in `dist/`, tests in `tests/` (not included in build)

### Code Style

- 2-space indentation
- Discriminated unions for result types (check `status` / `type` field)
- Classes use `private` constructor + `static async create()` pattern for async init (see `SolverSession`, `SkillLibrary`)
- Solver instances always call `dispose()` in `finally` blocks
- Error handling: catch and return `{ status: "error", error: msg }` rather than throwing
- `as const` used for tool schema type assertions

### Naming

- Files: kebab-case (`correction-loop.ts`, `z3-solver.ts`)
- Classes: PascalCase (`SolverSession`, `SkillLibrary`, `FormalizationEngine`)
- Functions: camelCase (`createZ3Solver`, `lintSpec`, `classifyFeedback`)
- Types/Interfaces: PascalCase (`SolverResult`, `SkillTemplate`, `CodeGraph`)
- Template names: kebab-case (`policy-contradiction-check`)

## Testing

- **Framework**: Vitest with `globals: true` — use `describe`/`it`/`expect` directly
- **Test location**: `tests/` directory, mirrors `src/` structure
- **Also included**: `benchmark/tests/` for benchmark test suites
- **Timeout**: 30 seconds per test (Z3 WASM init is slow)
- **Coverage**: V8 provider, covers `src/**/*.ts`

### Test Patterns

```typescript
import { describe, it, expect, afterEach } from "vitest";

describe("Z3Solver", () => {
  let solver: Solver;
  afterEach(() => { solver?.dispose(); });

  it("returns sat with a model", async () => {
    solver = await createZ3Solver();
    const result = await solver.solve({ type: "z3", smtlib: `...` });
    expect(result.status).toBe("sat");
    if (result.status === "sat") {  // TypeScript narrowing
      expect(result.model).toHaveProperty("x");
    }
  });
});
```

- Always narrow discriminated unions with `if (result.status === "sat")` before accessing status-specific fields
- Solver instances created per-test, disposed in `afterEach`
- Import paths from tests use `../src/...` with `.js` extension

## MCP Tools

11 tools exposed via MCP (defined in `src/mcp-server.ts`):

| Tool | Requires LLM? | Purpose |
|------|:---:|---------|
| `chiasmus_verify` | No | Submit raw SMT-LIB or Prolog → verified result. Also accepts `format="mermaid"` → parses flowchart/stateDiagram into Prolog facts automatically. |
| `chiasmus_skills` | No | Search/list formalization templates |
| `chiasmus_formalize` | No* | Find template + slot-filling instructions |
| `chiasmus_solve` | Yes | End-to-end: template → fill → lint → verify → correct |
| `chiasmus_learn` | Yes | Extract reusable template from verified solution |
| `chiasmus_lint` | No | Fast structural validation without running solver |
| `chiasmus_graph` | No | Source code call graph analysis (tree-sitter + Prolog / native O(V+E)). 16 analyses; see below. Supports per-file content-hash cache (`cache=true`) + named graph snapshots (`save_snapshot`, `against`). TS/JS carry qualified callees (`calleeQN`) and resolved imports (`resolved`) when inferable. |
| `chiasmus_map` | No | Pre-built codebase map: repo outline, per-file detail, or symbol lookup. Share with an LLM **before** bulk file reads to cut redundant reads/greps. Three modes (`overview`/`file`/`symbol`), markdown or JSON. Reuses the same tree-sitter extraction + per-file cache as `chiasmus_graph`. |
| `chiasmus_search` | Embed† | Semantic code search over a set of files. NL query → ranked list of callable defines via embeddings + cosine similarity. Caches embeddings by content SHA-256 under `$CHIASMUS_HOME/embeddings`. |
| `chiasmus_craft` | No | Create new template from LLM-designed spec |
| `chiasmus_review` | No | Return phased code-review recipe (graph analyses + verification templates). `delta_against=<snapshot>` enables PR-scoped review: a phase 0 diffs against the snapshot and scopes later phases to changed symbols. |

*`chiasmus_formalize` uses a dummy LLM that returns "" when no API key is set — it still selects the template.
†`chiasmus_search` needs an embedding provider, picked up from `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` (overridable via `CHIASMUS_EMBED_MODEL`, `CHIASMUS_EMBED_URL`, `CHIASMUS_EMBED_DIM`).

### `chiasmus_graph` analyses

Defined by `GRAPH_ANALYSES` in `src/graph/tool-handlers.ts` and dispatched by `runAnalysis` in `src/graph/analyses.ts`:

| Analysis | Required args | Purpose |
|---|---|---|
| `summary` | — | Overview counts (nodes, edges, languages) |
| `callers` | `target` | Direct callers of `target` |
| `callees` | `target` | Direct callees of `target` |
| `reachability` | `from`, `to` | Boolean: can `from` reach `to`? |
| `path` | `from`, `to` | Shortest call chain `from → … → to` |
| `impact` | `target` | Transitive callers (who is affected by a change) |
| `dead-code` | *(opt.)* `entry_points` | Symbols unreachable from entry points; auto-detects exports when omitted |
| `cycles` | — | Circular call dependencies |
| `layer-violation` | — | Calls that skip layers (e.g. handler → db bypassing service) |
| `communities` | — | Louvain clusters (seed=42) with cohesion scores |
| `hubs` | — | Top-degree nodes |
| `bridges` | — | Top betweenness — nodes connecting otherwise-separate subgraphs |
| `surprises` | — | Cross-community + peripheral → hub edges |
| `diff` | `against` | Current graph vs a saved snapshot; covers nodes, edges, imports, exports, hyperedges |
| `entry-points` | — | Zero-in-degree exports (feeds `dead-code`) |
| `facts` | *(opt.)* `include_insights` | Raw Prolog facts for `chiasmus_verify`. `include_insights=true` also emits `community/2`, `cohesion/2`, `hub/2`, `bridge/2` |

Cache + snapshot workflow:

- `cache=true` enables the SHA256 per-file extraction cache (`~/.cache/chiasmus` or `$CHIASMUS_CACHE_DIR`). Unchanged files skip re-parsing across calls.
- `save_snapshot="main"` persists the extracted `CodeGraph` under a name; requires `cache=true`.
- `analysis="diff"` + `against="main"` compares current extraction to that snapshot.
- Guard: `save_snapshot` and `against` naming the same snapshot is rejected — otherwise the save would clobber the baseline before the diff runs.

### `chiasmus_map` modes

Returns a compact projection of the tree-sitter graph. Implemented in `src/graph/map.ts`, wired in `handleMap` (`src/graph/tool-handlers.ts`). Purpose: hand an LLM a pre-built outline so it doesn't re-read/grep files to learn what's there.

| Mode | Required args | Output |
|---|---|---|
| `overview` *(default)* | `files` | Dir-grouped outline: per-file headlines with language, line count, token estimate, leading doc, exports with signatures |
| `file` | `files`, `path` | Single-file detail: exports, imports grouped by source, all top-level symbols |
| `symbol` | `files`, `name` | Where `name` is defined (file + line + signature) plus direct callers and callees |

Options:
- `format`: `"markdown"` *(default)* or `"json"`. Markdown is optimised for LLM consumption; JSON for programmatic use.
- `include`: array of glob patterns to filter overview (`**`, `*`, `?` supported). E.g. `["**/src/**"]`.
- `max_exports`: cap on exports-per-file surfaced in overview (default 8; negative values clamp to 0).
- `cache=true`: reuse the shared per-file extraction cache (same directory and invalidation as `chiasmus_graph`).

Data sources (added to `CodeGraph` for this feature):
- `FileNode.fileDoc` — language-specific, idiomatic doc only: TS/JS JSDoc `/** */`, Python `"""..."""` module docstring, Go `//` package-doc comments, Rust `///` and `//!` doc comments, Scheme/Racket/Common Lisp leading `;;;` blocks. Plain `//` line comments in TS/JS, `#` comments in Python, `;;` comments in the lisps, and `;` comments in Clojure are intentionally rejected (usually license/shebang noise).
- `FileNode.tokenEstimate` — `ceil(content.length / 3.5)` so an agent can read-budget.
- `FileNode.lineCount` — newline-count with trailing-line adjustment.
- `DefinesFact.signature` — params + return type (TS/JS/Python/Go/Rust); arglist vector for Clojure `defn` and `defprotocol`/`definterface` methods; arglist for Scheme `define` and Common Lisp `defun`.
- TypeScript exports now also include `interface`, `type`, and `enum` declarations, so `exportCount` reflects the full public surface.
- `FileNode.namespace` — the file's `(in-package ...)` for Common Lisp; drives cross-file package resolution. Unset for every other language.
- Cache schema is currently `"4"` (bumped when `FileNode.namespace` landed). Older caches auto-invalidate on upgrade.

### TS/JS qualified-name resolution

Two passes, both best-effort (failure never blocks the base graph):

1. **Per-file** (`collectTypeInfo` in `src/graph/extractor.ts`) — walks each TS/JS AST to extract:
   - class/interface `extends` edges (both `class_heritage > extends_clause` and the interface-direct `extends_type_clause` shape),
   - class/interface fields (`extractClassFields` in `type-env.ts`) + methods (`method_definition` and interface `method_signature`),
   - pending call sites with their receiver chain (e.g. `['this', 'svc']` + `login`),
   - per-scope local variable types (Tier 0 annotation → Tier 1 `new` → Tier 2 assignment-chain inference).
   Wrapped in try/catch — an unexpected AST shape drops only the QN data for that file.

2. **Project-wide** (`resolveCallsWithRegistry` in `src/graph/resolve-calls.ts`) — merges per-file type info into:
   - `ClassFieldRegistry` with inheritance propagation (child fields shadow parent).
   - `ClassMethodRegistry` exposing `{ own, flat, parents }` so the resolver can verify a method exists on the receiver type *and* walk up to find the declaring class (`Child.run()` → `Svc.run` when `run` is only defined on `Svc`).
   - `JS_BUILTIN_TYPES` blacklist rejects builtins (`Map`, `Promise`, `any`, `string`, `ReadonlySet`, …) so their prototype methods don't leak into QNs.
   - Fallbacks: (a) unique method owner via `graph.contains`, (b) unique flat-registry owner. Ambiguous names stay without a QN rather than guess.

Matching `CallsFact`s get their `calleeQN = "Class.method"`. Emitted as `calls_qn/3` Prolog facts alongside back-compat `calls/2`.

### S-expression languages (Scheme / Racket / Common Lisp)

`src/graph/extract-sexp.ts`, dispatched from `extractFromTree`. Same two-phase shape as `walkClojure` (top-level defines first, then call edges), plus two things Clojure doesn't need:

- **Lexical scope.** Both walkers carry a set of locally bound names — lambda parameters, `let`/`labels` bindings, internal defines, a named let's loop variable — and skip them for both the head-symbol rule and the in-file-reference rule. Without it `(let loop ((i 0)) ... (loop ...))` mints a global `loop` node in every file, and those merge into one fabricated hub that skews `hubs`/`bridges`/`communities`.
- **Cross-file package resolution** (`resolveCommonLispPackageCalls`). A CL package spans files, so a bare callee could be a sibling define or a standard-library function; the per-file walk leaves it bare and this pass, run on the merged graph, promotes the ones that match a define in the caller's package. Runs only when the batch has a `commonlisp` file, and leaves the standard library bare so `subseq` doesn't become one node per calling package.

Names are package-qualified for Common Lisp (`app:run`, from `(in-package :app)`, with `pkg::name` normalized to `pkg:name`) and bare for Scheme — Scheme's module story is split across R6RS/R7RS/Guile/Racket with no single file-level declaration to key on. `resolveTargets` in `native-analyses.ts` matches an unqualified target against both `/` (Clojure) and `:` (CL) suffixes.

Exports default to every top-level definition, and narrow to the explicit list when the file has one: `(provide ...)`, `(export ...)`, Guile `#:export`, or a `defpackage` `(:export ...)` clause.

Grammars are vendored WASM under `grammars/` — see `grammars/README.md` for provenance, why Scheme can't use the native bindings, and how to rebuild.

web-tree-sitter (all four Lisp grammars) is initialised once per thread: `initWasm()` and each grammar's `Language.load()` are single-flight promises, since concurrent parses on a cold thread would otherwise each instantiate their own runtime and grammar. `extractGraph` extracts files one at a time, so each WASM tree is walked and freed (`tree.delete()`) before the next file parses; started together, every tree of the batch would sit in the WASM heap at once, and the wasm32 heap tops out at 4 GB.

### Import resolution

`extractGraph(files, { repoPath })` resolves each `ImportsFact.source` to a repo-relative `resolved` path when possible:
- `tsconfig-aliases.ts` parses `tsconfig.json` (JSONC + `extends`, cycle-safe) and rewrites `@/foo` → `src/foo`.
- `suffix-index.ts` builds a suffix index over the batch file paths. Relative imports (`./foo`, `../foo`) resolve **exactly** from the importing file's directory — no fallback to shorter suffixes, so a stale batch doesn't silently match an unrelated same-basename file.
- External packages and bare specifiers stay `resolved=undefined`.
- If `repoPath` is omitted, the longest common ancestor of the batch is used. Emitted as `imports_resolved/3` Prolog facts.

### Semantic search (`chiasmus_search`)

- Corpus = one entry per callable define (function or method) — text is `name + signature + fileDoc + 6-line body snippet`, capped at 2000 chars.
- `VectorStore` — linear-scan cosine similarity; L2-normalized on query; serializable. Correct up to ~10k vectors; swap in an HNSW backing if the corpus grows.
- `EmbeddingCache` — SHA-256(content) keyed, one JSON file per dimension under `$CHIASMUS_HOME/embeddings/dN.json`. Atomic writes via `.tmp + rename`. Dimension mismatch on load silently discards (clean model swap).
- `OpenAICompatibleEmbeddingAdapter` batches 96 inputs per request and preserves order via the response `index` field.
- First call with unknown dimension (no `CHIASMUS_EMBED_DIM` set) skips the cache — dimension is learned from the response and subsequent calls cache normally.

## Gotchas

### Z3 Solver
- Z3 WASM init loads ~30MB — cached in module scope (`z3Promise` singleton)
- Input is sanitized: `(check-sat)`, `(get-model)`, `(set-logic)`, `(exit)` are auto-stripped
- Use `(assert (! expr :named label))` for readable UNSAT cores
- Use `(= flag (or ...))` NOT `(=> ... flag)` — implication is trivially SAT
- No `(define-fun)` with args — breaks model extraction; use `(declare-const)` + `(assert (=))` instead
- Solver timeout: 30 seconds
- Empty input after sanitization returns `{ status: "sat", model: {} }`

### Prolog Solver
- Backed by `prolog-wasm-full` (SWI-Prolog 10.1.4 in WebAssembly, includes `library(clpfd)`)
- Single global SWI instance (Emscripten factory invalidates after first instantiation); per-`solve()` isolation via temp-file consult + `abolish/1` cleanup
- Max 1000 answers per query, default 100,000 inference budget (`maxInferences` overrides; goal wrapped in `call_with_inference_limit/3`)
- Derivation tracing instruments rules by injecting `assertz(trace_goal(head))` into each rule body
- Errors during consult are captured via a `user:message_hook/3` that asserts to `'$chiasmus_msg'/2`; query syntax errors are pre-validated via `read_term_from_atom/3` (the stock query API doesn't propagate parse errors)
- Prolog clauses must end with periods

### General
- `SolverSession.create()` is async (Z3 init) — always `await` it
- `SkillLibrary.create()` is async (SQLite init) — always `await` it
- Correction loop delegates to `repl-sandbox` package's generic `correctionLoop`
- `chiasmus_solve` falls back to `chiasmus_formalize` when no API key is set
- Test imports use `../src/solvers/z3-solver.js` (not `../../dist/...`)
- Template slots use `{{SLOT:name}}` markers in skeleton strings
- Lint tool (`formalize/validate.ts`) auto-fixes markdown fences, `(check-sat)`, `(get-model)`, `(set-logic)` before reporting errors

### Graph child process
- `chiasmus_graph` and `chiasmus_map` run in a child process (`runGraphTool` → `GraphChildPool`, a `child_process.fork()` of `graph/graph-child.ts`), so tree-sitter extraction and graph analyses never block the server (other tool calls, pings, cancellation). One child per process, fed by a FIFO queue capped at 32 waiting jobs (beyond that a job gets `{"error":"graph worker queue is full ..."}` immediately). Jobs run one at a time, so a small graph call still waits behind a running large one; only graph calls wait, not the rest of the server.
- A job is stopped by `SIGKILL` of its child, always: when its MCP request is cancelled (the handler passes `extra.signal`, which the SDK aborts on `notifications/cancelled` and when the transport closes; a job still queued is just dropped), when it runs past the job timeout (10 min, `CHIASMUS_GRAPH_JOB_TIMEOUT_MS`: digits only, capped at 2^31-1 ms because a longer `setTimeout` fires after 1 ms), and on shutdown. No SIGTERM first: a busy child could not run a handler before its current synchronous step (one tree walk, one analysis) returns, and it holds nothing that needs a clean exit (see Graph cache). The next job forks a fresh child. After a cancellation it starts on a later event-loop turn: on transport close the SDK aborts every in-flight request in one synchronous loop, and starting the next queued job at once would fork a child per queued call only for the next abort to kill it.
- `GraphChildPool` never throws or rejects: `pump()` also runs from child listeners and timers, where a throw is an uncaught exception that ends the server. A child that can't be started (`fork()` throws, or runs out of file descriptors and returns a child with no IPC channel) fails the job with `{"error":"graph worker could not start for <tool>: ..."}`; a job that can't be sent replaces the child and fails with `could not send the job`. No job is retried.
- Not a worker thread: `worker.terminate()` (or `process.exit()`) while a thread is inside native tree-sitter makes node-addon-api's `Napi::Error` escape and aborts the whole server with SIGABRT, and a single file's tree walk can run for seconds with no point where a thread could stop cooperatively. `tests/graph/child-kill-mid-walk.test.ts` cancels, closes, SIGTERMs and `process.exit()`s mid-walk.
- The child persists between jobs (grammars stay loaded) and is replaced before the next job when it crashes or exits, reports a fatal WASM error (`isFatalWasmError` in `graph/parser.ts` — web-tree-sitter state is undefined after a trap), reports an RSS over 2 GiB after a job (its own: web-tree-sitter's WASM heap only grows, and native tree-sitter memory goes back to the OS only when the process exits), has served 100 jobs, or idles for 5 min. A lost job comes back as `{"error":"graph worker crashed while running <tool>: ..."}`. A child whose IPC channel closes is taken out of service at once: a busy child would not notice the closed channel before its current synchronous step returns, and its watchdog only looks for the parent. The channel also closes as any child dies, just before its `exit`, so the pool waits 100 ms, and one more event-loop poll, for that `exit`: a crash, the OOM killer or `kill -9` is reported with its own exit code or signal. A child still running then is SIGKILLed, and its job fails as `IPC channel closed (killed by SIGKILL)` once the exit is reaped. `CHIASMUS_GRAPH_WORKER_HEAP_MB` sets the child's `--max-old-space-size` (default: Node's, as for the server); an overrun kills only the child.
- Each job carries the parent's current working directory and environment, and the child adopts them before running, so `defaultRepoKey()` (a hash of the working directory), `CHIASMUS_CACHE_DIR` and `HOME` resolve as they would inline: the cache and snapshots are shared with inline calls. Adapter discovery runs in the child when `config.adapterDiscovery` is set, and also once the server process has run `discoverAdapters()` itself (`discoveryStarted()`, e.g. a library caller), so the child sees the adapters an inline call would; adapters registered in code with `registerAdapter()` can't be sent to it (`extract()` is a function), so once any is registered (`hasCodeRegisteredAdapters()`) `runGraphTool` runs the tools inline, as `CHIASMUS_GRAPH_WORKER=off` does.
- From `dist/` the child is `dist/graph/graph-child.js`; from source (tsx, vitest) it is the `.ts` file run with `--import tsx`. Only the parent's loader flags (`--import`/`--require`/`--loader`/`--conditions`) reach the child: `-e` would make it run that code instead, `--inspect` would clash on the port, and the heap limit is its own. The child's stdout goes to the parent's stderr, since the parent's stdout may be the MCP stdio transport.
- The child never outlives the server. Every `process.exit()` in the server (a shutdown handler's exit, an exit a host makes on a fatal error) SIGKILLs it synchronously from a process `'exit'` listener the pool adds for each child it forks, so the exit is immediate and leaves no child behind (`tests/graph/child-kill-mid-walk.test.ts`). The exit needs no stop-the-child-first step: no worker thread in the server runs tree-sitter. `chiasmus_search` still parses inline (as graph calls do when run inline), but on the main thread, which is also where an exit runs, so the exit never lands inside a native tree-sitter call. For a server that dies without running listeners (SIGKILL, a native crash): an idle child exits on IPC `disconnect`; a busy one would not see that until its current synchronous step returns, so a watchdog thread in the child checks for the parent every 500 ms and SIGKILLs the child once it is gone. Shutdown (`setupShutdownHandlers`) calls `shutdownGraphChild()`, which kills the child, waits for it to exit and leaves the shared pool closed, so later graph calls get `{"error":"graph worker is shut down"}`.

### Graph cache
- Every cache write holds `proper-lockfile` on `<repoDir>/.lock` (`withRepoLock`): `saveFileCache`'s manifest read-modify-write and per-file entries, eviction, and `saveSnapshot` — concurrent MCP dispatches don't tear the manifest, and no temp file is written outside the lock
- Per-file writes are atomic via `.tmp` + rename, parallelized with `Promise.all` inside the single lock acquisition
- Eviction is folded into the save lock block with a manifest-sum fast path: the O(N) `fs.readdir`/`fs.stat` sweep only runs when the manifest-tracked total exceeds the per-repo budget, or after a writer died mid-write (below). The fast path only holds while the manifest lists every entry on disk: a file whose content changed gets a new entry (the hash names it), and its old one is deleted once the new manifest is written
- LRU uses file `mtime`; `checkFileCache` bumps it via `fs.utimes` on hits (best-effort, concurrent eviction is tolerated by the read path)
- Snapshot names are validated against `/`, `\`, `..`, `\0` — path traversal rejected at every entry point
- Cache schema versioned via `CACHE_SCHEMA_VERSION` in the manifest; mismatch silently invalidates all entries rather than throwing
- The graph child gets SIGKILLed by design, possibly mid-write and holding the lock. Per-file entries, the manifest and snapshots are all written to a temp name and renamed, and readers never open temp names, so a kill never leaves a torn file. What a dead writer leaves (a half-written `.tmp`, or per-file entries renamed into place that the manifest never listed, which the fast path would never count) is reclaimed by the next writer, whatever it writes: each writer creates `<repoDir>/.write-in-progress` under the lock before its first write and removes it after its last, and a writer that finds it on taking the lock deletes every `.tmp` (entries, manifest, snapshots) and every entry the manifest does not list first. A failed write (a full disk) leaves the marker too, and so does a reclaim that can't finish: one that can't read the manifest (EMFILE) deletes only the temp files and leaves the entries to the next writer, and one that can't list a cache directory or remove an entry (anything but ENOENT) keeps the marker so the next writer tries again. The eviction sweep drops manifest entries whose file is gone (deleted from outside, or by a writer killed mid-eviction), whose sizes would otherwise keep every later save sweeping. A lock the killed child held goes stale 5 s after its last refresh (proper-lockfile `stale`), so the next cached save can wait up to 5 s. The marker means the previous holder died *or* lost the lock: proper-lockfile also treats a live holder whose event loop stalls past those 5 s (for example inline mode, `CHIASMUS_GRAPH_WORKER=off`, while another call's long native walk blocks the same process) as stale, and the next holder's reclaim can then remove the stalled writer's temp files, whose rename then fails. That limit predates the marker; the child design avoids it by default because graph work never blocks the server's event loop. `tests/graph/cache-kill-mid-write.test.ts` kills the real child halfway through each kind of write.
