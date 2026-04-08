# Chiasmus

MCP server that gives LLMs access to formal verification via Z3 (SMT solver) and Tau Prolog, plus tree-sitter-based source code analysis. Translates natural language problems into formal logic using a template-based pipeline, verifies results with mathematical certainty, and analyzes call graphs for reachability, dead code, and impact analysis.

### Example use cases

- **"Can our RBAC rules ever conflict?"** → Z3 finds the exact role/action/resource triple where allow and deny both fire
- **"Find compatible package versions"** → Z3 solves dependency constraints with incompatibility rules, returns a valid assignment or proves none exists
- **"Can user input reach the database?"** → Prolog traces all paths through the call graph, flags taint flows to sensitive sinks
- **"Are our frontend and backend validations consistent?"** → Z3 finds concrete inputs that pass one but fail the other (e.g. age=15 passes frontend min=13 but fails backend min=18)
- **"Does our workflow have dead-end or unreachable states?"** → Prolog checks reachability from the initial state, identifies orphaned and terminal nodes
- **"What's the dead code in this module?"** → tree-sitter parses source files, Prolog finds functions unreachable from any entry point
- **"What breaks if I change this function?"** → call graph impact analysis shows all transitive callers

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

**`chiasmus_graph`** — Analyze source code call graphs via tree-sitter + Prolog. Parses TS/JS files, extracts cross-module call graphs, runs formal analyses.

```
chiasmus_graph files=["src/server.ts", "src/db.ts"] analysis="callers" target="query"
→ { analysis: "callers", result: ["handleRequest"] }

chiasmus_graph files=["src/**/*.ts"] analysis="dead-code"
→ { analysis: "dead-code", result: ["unusedHelper", "legacyParser"] }

chiasmus_graph files=["src/**/*.ts"] analysis="reachability" from="handleRequest" to="dbQuery"
→ { analysis: "reachability", result: { reachable: true } }

chiasmus_graph files=["src/**/*.ts"] analysis="impact" target="validate"
→ { analysis: "impact", result: ["handleRequest", "main"] }
```

Analyses: `summary`, `callers`, `callees`, `reachability`, `dead-code`, `cycles`, `path`, `impact`, `facts`.

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

**`chiasmus_learn`** — Extract a reusable template from a verified solution. Candidates get promoted after 3+ successful reuses.

**`chiasmus_lint`** — Fast structural validation of specs without running the solver.

## Recommended Workflow

The calling LLM (Claude, GPT, etc.) drives the process — no API key needed:

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

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHIASMUS_HOME` | `~/.chiasmus/` | Database and skill storage |
| `ANTHROPIC_API_KEY` | — | Optional: Anthropic provider for autonomous mode |
| `DEEPSEEK_API_KEY` | — | Optional: DeepSeek provider for autonomous mode |
| `OPENAI_API_KEY` | — | Optional: OpenAI provider for autonomous mode |
| `CHIASMUS_API_URL` | per provider | Override API base URL (e.g. for local models via Ollama) |
| `CHIASMUS_MODEL` | per provider | Override model name |

Providers are checked in order: Anthropic → DeepSeek → OpenAI. Only one key is needed for autonomous mode (`chiasmus_solve`, `chiasmus_learn`). When used from Claude Code, Crush, or OpenCode, no API key is needed — the calling LLM handles template filling directly.

## License

Apache-2.0
