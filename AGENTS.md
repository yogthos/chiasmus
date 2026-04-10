# AGENTS.md — Chiasmus

## Project Overview

Chiasmus is an MCP (Model Context Protocol) server that gives LLMs access to formal verification via **Z3** (SMT solver) and **Tau Prolog**. It also provides tree-sitter-based source code call graph analysis. The server translates natural language problems into formal logic using a template-based pipeline, verifies results with mathematical certainty, and analyzes call graphs for reachability, dead code, and impact analysis.

- **Language**: TypeScript (strict mode, ESM)
- **Runtime**: Node.js ≥20
- **License**: Apache-2.0
- **Package**: npm package `chiasmus`, exposes a CLI binary

## Commands

```bash
npm run build          # Compile TypeScript (tsc) → dist/
npm run typecheck      # Type-check only (tsc --noEmit)
npm run test           # Run tests in watch mode (vitest)
npm run test:run       # Run tests once (vitest run)
npm run test:coverage  # Run tests with V8 coverage report
npm run mcp            # Run MCP server locally via tsx
```

### CI Pipeline

CI runs on push/PR to `main` (`.github/workflows/test.yml`):
1. `npm ci`
2. `npm run typecheck`
3. `npm run test:run`

Tested on Node 20 and 22.

## Code Organization

```
src/
├── mcp-server.ts          # Entry point — MCP server, all tool handlers, CLI bootstrap
├── config.ts              # Loads ~/.chiasmus/config.json
├── solvers/
│   ├── types.ts           # SolverType, SolverResult (discriminated union), Solver, SolverInput
│   ├── session.ts         # SolverSession — factory for Z3/Prolog solver instances
│   ├── z3-solver.ts       # Z3 WASM wrapper (z3-solver npm), auto-strips check-sat/get-model
│   ├── prolog-solver.ts   # Tau Prolog wrapper, derivation tracing via assertz
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
│   ├── types.ts           # CodeGraph, LanguageAdapter, DefinesFact, CallsFact, etc.
│   ├── extractor.ts       # tree-sitter parsing + multi-language call graph extraction
│   ├── parser.ts          # AST walking for TS/JS/Python/Go/Clojure
│   ├── facts.ts           # graphToProlog — converts CodeGraph to Prolog facts + rules
│   ├── analyses.ts        # runAnalysis — dispatches graph analyses via Prolog queries
│   ├── mermaid.ts         # parseMermaid — converts Mermaid flowcharts/state diagrams to Prolog
│   └── adapter-registry.ts # Auto-discovery of chiasmus-adapter-* npm packages
├── llm/
│   ├── types.ts           # LLMAdapter interface, LLMMessage
│   ├── anthropic.ts       # Anthropic/DeepSeek/OpenAI provider factory (createLLMFromEnv)
│   ├── openai-compatible.ts # OpenAI-compatible API adapter
│   └── mock.ts            # Mock LLM for testing
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
```

Provider priority: `ANTHROPIC_API_KEY` → `DEEPSEEK_API_KEY` → `OPENAI_API_KEY`.

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

9 tools exposed via MCP (defined in `src/mcp-server.ts`):

| Tool | Requires LLM? | Purpose |
|------|:---:|---------|
| `chiasmus_verify` | No | Submit raw SMT-LIB or Prolog → verified result |
| `chiasmus_skills` | No | Search/list formalization templates |
| `chiasmus_formalize` | No* | Find template + slot-filling instructions |
| `chiasmus_solve` | Yes | End-to-end: template → fill → lint → verify → correct |
| `chiasmus_learn` | Yes | Extract reusable template from verified solution |
| `chiasmus_lint` | No | Fast structural validation without running solver |
| `chiasmus_graph` | No | Source code call graph analysis (tree-sitter + Prolog) |
| `chiasmus_craft` | No | Create new template from LLM-designed spec |
| `chiasmus_review` | No | Return phased code-review recipe (graph analyses + verification templates) |

*`chiasmus_formalize` uses a dummy LLM that returns "" when no API key is set — it still selects the template.

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
- Tau Prolog is callback-based — wrapped in promises (`consult`, `query`, `nextAnswer`)
- Max 1000 answers per query, max 100,000 inferences
- **No recursive reachability on cyclic graphs** — Tau Prolog lacks tabling → infinite loop. Query edges individually, BFS externally.
- Derivation tracing instruments rules by injecting `assertz(trace_goal(head))` into each rule body
- Prolog clauses must end with periods

### General
- `SolverSession.create()` is async (Z3 init) — always `await` it
- `SkillLibrary.create()` is async (SQLite init) — always `await` it
- Correction loop delegates to `repl-sandbox` package's generic `correctionLoop`
- `chiasmus_solve` falls back to `chiasmus_formalize` when no API key is set
- Test imports use `../src/solvers/z3-solver.js` (not `../../dist/...`)
- Template slots use `{{SLOT:name}}` markers in skeleton strings
- The `as any` casts on Tau Prolog session objects are intentional — the library's TypeScript types are incomplete
- Lint tool (`formalize/validate.ts`) auto-fixes markdown fences, `(check-sat)`, `(get-model)`, `(set-logic)` before reporting errors
