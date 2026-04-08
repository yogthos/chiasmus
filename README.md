# Chiasmus

MCP server that gives LLMs access to formal verification via Z3 (SMT solver) and Tau Prolog. Translates natural language problems into formal logic using a template-based pipeline, verifies results with mathematical certainty.

## Setup

```bash
npm install chiasmus
```

Add to Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "chiasmus": {
      "command": "npx",
      "args": ["chiasmus"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

`ANTHROPIC_API_KEY` is only needed for `chiasmus_solve` and `chiasmus_learn`. Other tools work without it.

## Tools

**`chiasmus_verify`** — Submit raw SMT-LIB or Prolog, get a verified result.

```
chiasmus_verify solver="z3" input="
  (declare-const x Int)
  (declare-const y Int)
  (assert (= (+ x y) 10))
  (assert (> x 0))
  (assert (> y 0))
"
→ { status: "sat", model: { x: "7", y: "3" } }
```

```
chiasmus_verify solver="prolog"
  input="parent(tom, bob). parent(bob, ann). ancestor(X,Y) :- parent(X,Y). ancestor(X,Y) :- parent(X,Z), ancestor(Z,Y)."
  query="ancestor(tom, Who)."
→ { status: "success", answers: [{ bindings: { Who: "bob" } }, { bindings: { Who: "ann" } }] }
```

**`chiasmus_skills`** — Search the template library. Ships with 8 starter templates covering authorization, configuration, dependency resolution, validation, rule inference, and graph reachability.

**`chiasmus_formalize`** — Find the best template for a problem, get slot-filling instructions back. You fill the slots using your context, then call `chiasmus_verify`.

**`chiasmus_solve`** — End-to-end: selects template, fills slots via LLM, runs lint and correction loops, returns a verified result. Requires API key.

**`chiasmus_learn`** — Extract a reusable template from a verified solution. Candidates get promoted after 3+ successful reuses.

## When to use

Use a solver when the LLM alone can't guarantee correctness:

- **"Does this hold for ALL inputs?"** — solvers prove universally, LLMs just check examples
- **"Do these rules ever conflict?"** — contradiction detection over combinatorial spaces
- **"Can X reach Y through any path?"** — transitive closure / reachability
- **Access control, configs, dependencies** — where correctness is non-negotiable

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHIASMUS_HOME` | `~/.chiasmus/` | Database and skill storage |
| `ANTHROPIC_API_KEY` | — | For `chiasmus_solve` and `chiasmus_learn` |
| `CHIASMUS_MODEL` | `claude-sonnet-4-20250514` | Model for internal LLM calls |

## License

Apache-2.0
