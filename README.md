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
