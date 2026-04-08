# Benchmark Problems

Each problem is solved twice:
1. **Traditional** — LLM reasons through the problem and writes a programmatic solution
2. **Chiasmus** — LLM uses chiasmus tools (formalize → fill → verify)

## Metrics tracked per problem per approach

- **Tokens**: approximate input+output tokens consumed
- **Attempts**: number of tries before tests pass
- **Quality**: correctness on edge cases (scored 1-5)
- **Test time**: how quickly tests pass (attempts × avg time)

## Problems

### 1. RBAC Policy Conflict Detection
Given a set of role-based access control rules (allow/deny), determine if any role can ever be both allowed and denied the same action on the same resource. Return a concrete counterexample if so.

### 2. Package Dependency Resolution
Given 5 packages with version ranges and inter-dependency constraints, find a valid version assignment or prove no valid assignment exists.

### 3. Data Flow Taint Analysis
Given a module dependency graph, determine if user-controlled input can reach a sensitive sink (database query, eval, file write) through any chain of calls.

### 4. Workflow State Machine Validation
Given a set of workflow states and transitions with guard conditions, determine: (a) can every state be reached from the initial state? (b) are there any dead-end states with no outgoing transitions?

### 5. API Validation Rule Consistency
Given two sets of validation rules (frontend and backend) for an API endpoint, determine if there's any input that passes frontend validation but fails backend validation (or vice versa).
