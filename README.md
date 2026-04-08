# Chiasmus

MCP server that gives LLMs access to formal verification via Z3 (SMT solver) and Tau Prolog. Translates natural language problems into formal logic using a template-based pipeline, verifies results with mathematical certainty.

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

**`chiasmus_formalize`** — Find the best template for a problem, get slot-filling instructions. Fill the slots using your context, then call `chiasmus_verify`.

**`chiasmus_solve`** — End-to-end: selects template, fills slots via LLM, runs lint and correction loops, returns a verified result. Optional — the same result is achieved by using `chiasmus_formalize` → fill slots → `chiasmus_verify`, which is the recommended workflow since the calling LLM has full conversation context.

**`chiasmus_learn`** — Extract a reusable template from a verified solution. Candidates get promoted after 3+ successful reuses.

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
