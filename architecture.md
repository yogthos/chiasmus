# Chiasmus: Neurosymbolic Verification Engine

## Vision

Chiasmus is an MCP server that gives language models access to formal verification. The LLM acts as a semantic translator — it understands what the user means and maps that understanding onto formal logic that a solver can verify with mathematical certainty. The solver's answer is provably correct, not probabilistically likely.

The core insight: LLMs are bad at logical reasoning but good at translation. Solvers are perfect at logical reasoning but can't understand natural language. Chiasmus bridges the gap with a template-based formalization pipeline that gets better over time.

## Architecture Overview

```
User prompt
  │
  ▼
┌─────────────────────────────────┐
│  Phase 1: NORMALIZE             │
│  LLM classifies problem type,   │
│  maps domain-specific inputs to │
│  common intermediate format     │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Phase 2: FORMALIZE             │
│  Embed problem signature,       │
│  retrieve matching template,    │
│  LLM fills slots in skeleton    │
│  (or generates from scratch     │
│   using closest as few-shot)    │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Phase 3: VERIFY                │
│  Submit to solver (Z3 / Tau     │
│  Prolog), catch errors, feed    │
│  back to LLM for correction     │
│  (max 5 rounds), return result  │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Phase 4: EXTRACT (optional)    │
│  Generalize solved problem into │
│  candidate skill template for   │
│  future reuse                   │
└─────────────────────────────────┘
```

## Why Templates, Not Free-Form Generation

Research on autoformalization (Draft-Sketch-Prove, Baldur, LEGO-Prover, DeepSeek-Prover) shows:

- **Single-pass LLM formalization accuracy: 15-30%** for nontrivial problems
- **Template/structured prompting** reduces compilation errors by 30-50%
- **Retrieval of similar past formalizations** is the single biggest accuracy boost
- **Verifier-in-the-loop repair** (3-5 rounds) pushes success to 50-70%

Free-form SMT-LIB or Prolog generation is unreliable. The LLM's job is narrowed to: find the right template, normalize the inputs, fill the slots. This is a translation task, which LLMs are good at.

## Target Domains

Ranked by frequency in day-to-day coding work and validated by production systems that already use solvers under the hood:

| Domain | Solver | Production precedent |
|--------|--------|---------------------|
| Policy/authorization verification | Z3 or Prolog | AWS Cedar, OPA/Rego, Teleport |
| Configuration validation | Z3 | Azure firewall verification |
| Dependency/version constraints | Z3 | Conda/libsolv, Spack/Clingo |
| Data validation rule consistency | Z3 | JSON schema analysis |
| Rule engine / business logic | Prolog | OPA, compliance engines |
| Static analysis patterns | Prolog/Datalog | CodeQL, Soufflé |

**When to use a solver instead of just asking the LLM:**
- Universal quantification needed ("does this hold for ALL inputs?")
- Combinatorial explosion (too many possibilities to enumerate)
- Correctness is non-negotiable (security, access control)
- Contradiction/inconsistency detection
- Recursive reachability / transitive closure

## Formalization Templates (Skills)

A template is a parameterized formal specification:

```yaml
name: policy-contradiction-check
domain: authorization
solver: z3
signature: "Check if a set of allow/deny rules can ever conflict"
skeleton: |
  (declare-datatypes ((Principal 0) (Resource 0) (Action 0)) ...)
  (declare-fun allow (Principal Resource Action) Bool)
  (declare-fun deny (Principal Resource Action) Bool)
  {{SLOT: rule_assertions}}
  (assert (exists ((p Principal) (r Resource) (a Action))
    (and (allow p r a) (deny p r a))))
  (check-sat)
normalizations:
  - source: "AWS IAM JSON"
    transform: "map Statement[].{Effect, Principal, Action, Resource} to triples"
  - source: "Django permissions"
    transform: "extract user as principal, permission as action, app as resource"
  - source: "Kubernetes RBAC"
    transform: "expand rules[].{verbs, resources} into action/resource pairs"
  - source: "natural language"
    transform: "extract entities, classify as principal/resource/action"
metadata:
  reuse_count: 0
  success_rate: 0.0
  last_used: null
  promoted: false
```

### Starter Templates (Ship With These)

**Z3:**
1. Policy contradiction detection — do allow/deny rules ever conflict?
2. Policy reachability — can principal X ever access resource Y?
3. Configuration equivalence — are two configs functionally identical?
4. Constraint satisfiability — find a solution given version/dependency constraints
5. Schema consistency — are validation rules contradictory or redundant?

**Prolog:**
1. Rule chain inference — given facts + rules, what conclusions follow?
2. Graph reachability — can node A reach node B through any path?
3. Permission derivation — given role hierarchy + rules, what can user X do?

### Skill Library Lifecycle

```
Solved problem
  → LLM abstracts concrete values into typed parameters
  → Generates signature + normalization schemas
  → Stored as candidate skill (promoted=false, reuse_count=0)
  → After N successful reuses → promoted=true
  → Unused for M sessions → demoted or pruned
  → Before adding: check embedding similarity against existing (merge if >0.9)
```

Lessons from LEGO-Prover (ICLR 2024): their library grew to 20,000+ skills but a 2025 analysis found most were single-use. We track reuse rigorously and prune aggressively. 50 well-validated templates beat 5,000 cached one-offs.

### Normalization Layer (Transfer Learning)

The normalization layer is what makes templates reusable across contexts. Each template defines mappings from domain-specific formats to its expected inputs. The LLM's translation job:

1. Recognize that an AWS IAM policy, a Django permission check, and a K8s RBAC rule are all instances of the same abstract pattern
2. Apply the appropriate normalization schema (or create a new one)
3. Produce the common intermediate format the template expects

New normalization patterns discovered during use get saved back to the template, so the system learns to handle more input formats over time.

## MCP Tool Surface

| Tool | Purpose | LLM required? |
|------|---------|---------------|
| `chiasmus_solve` | End-to-end: normalize → formalize → verify → return result | Yes |
| `chiasmus_verify` | Submit raw SMT-LIB or Prolog directly, get solver result | No |
| `chiasmus_formalize` | Normalize + formalize only, return formal spec for inspection | Yes |
| `chiasmus_skills` | Search/list templates in the skill library | No |
| `chiasmus_learn` | Extract a new candidate skill from a verified solution | Yes |

## Solver Engines

**Z3** via `z3-solver` npm package. WebAssembly build of Microsoft's SMT solver, runs entirely in Node. Handles satisfiability modulo theories — the LLM outputs SMT-LIB format or constructs JS API calls. Covers: integer/real arithmetic, bitvectors, arrays, datatypes, quantifiers.

**Tau Prolog** — pure JavaScript ISO Prolog interpreter. The LLM outputs Prolog facts and rules as a string, loaded into a fresh session. Covers: rule-based deduction, backtracking search, recursive queries, unification. Token-efficient syntax that LLMs generate accurately.

Both run entirely within the host process. No external API calls. Isolated, stateful contexts spin up instantly.

## Error Correction Loop

```
LLM generates formal spec
  → Solver attempts compilation/execution
  → On error: extract stack trace / error message
  → Feed error back into LLM prompt with original spec
  → LLM patches and resubmits
  → Repeat (max 5 rounds)
  → On convergence: return verified result
  → On failure to converge: return best attempt + diagnostics
```

Bounded at 5 rounds based on research showing diminishing returns past 3-5 iterations. On failure, return partial results with the error trace so the caller can decide next steps — never silently hang.

## Integration With Existing Systems

### From Matryoshka (direct code reuse)
- **SessionDB** (`src/persistence/session-db.ts`) — in-memory SQLite, FTS5 search
- **HandleRegistry** (`src/persistence/handle-registry.ts`) — handle-based token savings
- **HandleOps** (`src/persistence/handle-ops.ts`) — server-side operations on handles
- **CheckpointManager** (`src/persistence/checkpoint.ts`) — session persistence
- **NucleusEngine patterns** (`src/engine/`) — REPL execution model, error interception

### From Ori-Mnemos (direct code reuse)
- **Embedding infrastructure** — `@huggingface/transformers` all-MiniLM-L6-v2 for template retrieval
- **BM25 search** — keyword matching for template discovery
- **Retrieval patterns** — Q-value tracking for skill quality signals

### Not Reimplemented
- No new SQLite layer — use Matryoshka's SessionDB
- No new embedding system — use Ori's
- No new search fusion — use existing BM25 + semantic from either project
- No new handle system — use Matryoshka's HandleRegistry

## Configuration

Database location controlled by environment variable:

```
CHIASMUS_HOME=~/.chiasmus/   # default
```

Directory structure:
```
~/.chiasmus/
├── chiasmus.db              # SQLite — skill metadata, embeddings, reuse tracking
├── skills/
│   ├── z3/                  # Z3 templates (.smt2.tmpl)
│   ├── prolog/              # Prolog templates (.pl.tmpl)
│   └── learned/             # Auto-extracted candidates, not yet promoted
└── sessions/                # Ephemeral session state (checkpoints)
```

## Implementation Phases

Each phase follows strict TDD: write tests first, verify they fail, implement, verify they pass. Code review after each phase to catch bugs and design issues. After review, dogfood the tool to confirm it provides real value — if it doesn't, stop and rethink before moving on.

### Phase 1: Solver Sandbox

**Goal:** Get Z3 and Tau Prolog running in isolated, stateful contexts with clean input/output interfaces.

**Delivers:**
- `chiasmus_verify` MCP tool — submit raw SMT-LIB or Prolog, get result
- Solver abstraction layer (common interface over Z3 and Tau Prolog)
- Error capture and structured error reporting
- Session isolation (concurrent solver contexts)

**Tests:**
- Z3: submit valid SMT-LIB, get SAT/UNSAT + model
- Z3: submit invalid SMT-LIB, get structured error
- Tau Prolog: load facts + rules, query, get derivation
- Tau Prolog: submit malformed program, get structured error
- Concurrent sessions don't interfere with each other

**Review + Dogfood:** Can I (the LLM) submit formal specs directly and get useful verified results? Is the error reporting clear enough to self-correct?

### Phase 2: Error Correction Loop

**Goal:** Wire the solver sandbox into a bounded repair loop that takes an initial formalization attempt and iteratively fixes it.

**Delivers:**
- Correction loop engine (submit spec → get error → patch → resubmit, max 5 rounds)
- Structured prompts for each solver type's error format
- Convergence detection (solver returns valid result)
- Failure reporting (best attempt + error history on non-convergence)

**Tests:**
- Spec with minor syntax error converges within 2 rounds
- Spec with semantic error (wrong types) converges within 5 rounds
- Deliberately unfixable spec hits max rounds and returns diagnostics
- Loop correctly distinguishes solver errors from valid UNSAT results

**Review + Dogfood:** Given a rough but close formalization, does the loop reliably fix it? Are the error prompts informative enough? What's the typical round count?

### Phase 3: Skill Library + Template Retrieval

**Goal:** Persistent template storage with embedding-based retrieval. Ship the starter template set.

**Delivers:**
- `chiasmus_skills` MCP tool — search/list templates
- SQLite schema for template metadata and embeddings
- Embedding-based similarity search (reuse Ori's infrastructure)
- Starter template set (5 Z3 + 3 Prolog templates, hand-crafted)
- Template loading and slot identification

**Tests:**
- Store a template, retrieve by embedding similarity
- Retrieve correct template for each target domain
- Templates parse correctly and identify their slots
- Metadata tracking (reuse count, success rate) works
- `CHIASMUS_HOME` env var respected, defaults to `~/.chiasmus/`

**Review + Dogfood:** Does retrieval find the right template for real problems? Are the starter templates well-designed? Is the slot structure clear enough for an LLM to fill?

### Phase 4: Normalize + Formalize Pipeline

**Goal:** The full LLM-driven pipeline: classify problem, find template, normalize inputs, fill slots, send to solver with error correction.

**Delivers:**
- `chiasmus_solve` MCP tool — end-to-end pipeline
- `chiasmus_formalize` MCP tool — normalize + formalize without execution
- Problem type classification
- Normalization layer (domain-specific → common intermediate format)
- Template slot-filling with LLM
- Integration of phases 1-3 into the complete pipeline

**Tests:**
- Natural language policy question → correct Z3 template selected → verified result
- Natural language rule question → correct Prolog template selected → verified result
- Problem with no matching template → falls back to few-shot generation using closest templates
- Normalization correctly maps different input formats to same template

**Review + Dogfood:** End-to-end test on real problems from each target domain. Does the classification pick the right solver? Does normalization handle varied input formats? Is the full pipeline faster/more reliable than just asking the LLM to reason directly?

### Phase 5: Skill Learning + Quality Tracking

**Goal:** Extract new templates from verified solutions. Track reuse. Promote/prune over time.

**Delivers:**
- `chiasmus_learn` MCP tool — extract candidate skill from solution
- Template abstraction (concrete → parameterized)
- Normalization schema generation
- Reuse tracking and promotion logic
- Pruning of unused/low-quality templates
- Deduplication (merge if >0.9 embedding similarity)

**Tests:**
- Solve a novel problem → extract template → solve similar problem using extracted template
- Reuse counter increments on successful use
- Template promoted after N successful reuses
- Duplicate detection prevents near-identical templates
- Unused templates decay and get pruned

**Review + Dogfood:** Does the extraction produce genuinely reusable templates, or single-use caches? Test the LEGO-Prover failure mode: after accumulating some learned templates, are they actually being retrieved and reused for new problems?

## Design Principles

1. **Translation, not generation.** The LLM translates intent into a known formal structure. It doesn't generate novel formal logic from scratch.
2. **Templates over free-form.** Constrained slot-filling succeeds where unconstrained generation fails.
3. **Reuse over reimplementation.** Matryoshka's persistence, Ori's retrieval, existing solver packages. We glue, not rebuild.
4. **Bounded everything.** Max 5 correction rounds. Timeouts on solver calls. Graceful degradation with partial results.
5. **Earn trust through use.** Each phase must prove its value through dogfooding before the next phase begins. If it's not useful, stop and redesign.
6. **Skills must prove themselves.** Track reuse, success rate, recency. Prune aggressively. A small library of proven templates beats a large library of cached guesses.
