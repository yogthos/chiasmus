# Benchmark Results

## Metrics

| Problem | Approach | Attempts | Tests Pass | Quality (1-5) | Notes |
|---------|----------|----------|------------|---------------|-------|
| P1: RBAC Conflict | Traditional | 1 | 3/3 | 5 | Set intersection — straightforward |
| P1: RBAC Conflict | Chiasmus | 3 | 3/3 | 5 | First attempt: trivial SAT (unconstrained). Second: define-fun broke model extraction. Third: iff pattern worked. Z3 returns concrete counterexample. |
| P2: Dependency Resolution | Traditional | 1 | 4/4 | 4 | Backtracking search — correct but O(n^k) worst case |
| P2: Dependency Resolution | Chiasmus | 1 | 4/4 | 5 | Z3 handles constraint propagation natively, scales to large instances |
| P3: Taint Analysis | Traditional | 1 | 4/4 | 5 | BFS — clean and correct |
| P3: Taint Analysis | Chiasmus | 1 | 4/4 | 5 | Prolog reachability — natural fit |
| P4: Workflow Validation | Traditional | 1 | 4/4 | 5 | BFS + outgoing check — straightforward |
| P4: Workflow Validation | Chiasmus | 3 | 4/4 | 4 | Recursive Prolog hit infinite loop on cycles (rejected→draft). Fixed by driving BFS from TypeScript using Prolog for edge queries. |
| P5: Validation Gaps | Traditional | 1 | 5/5 | 4 | Range comparison — correct but manual, won't scale to complex constraints |
| P5: Validation Gaps | Chiasmus | 1 | 5/5 | 5 | Z3 finds concrete counterexamples automatically, handles arbitrary constraint shapes |

## Summary

| Metric | Traditional | Chiasmus |
|--------|------------|----------|
| Total attempts | 5 | 9 |
| Tests passing | 20/20 | 20/20 |
| First-attempt pass rate | 5/5 (100%) | 3/5 (60%) |
| Avg quality | 4.6 | 4.8 |

## Observations

**Traditional wins on simplicity:** For well-defined graph and set problems (P1, P3, P4), a few lines of TypeScript BFS/set-intersection is faster to write and runs instantly. The LLM doesn't need a solver for problems it can directly encode as algorithms.

**Chiasmus wins on guarantees and counterexamples:** For constraint problems (P2, P5), Z3 provides mathematically proven results and concrete counterexamples. The traditional approach requires implementing a custom solver (backtracking in P2) that may have bugs or performance issues at scale.

**Chiasmus learning curve:** The P1 and P4 failures were SMT-LIB/Prolog formulation issues — getting the encoding right required iteration. Once the pattern is known (use `iff` for Z3, drive BFS from TypeScript for cyclic Prolog graphs), it's reusable.

**Key insight:** Chiasmus is most valuable when the problem requires *proving something about all possible inputs* (P1: "can ANY request trigger both allow and deny?", P5: "is there ANY input that passes frontend but fails backend?"). Traditional approaches can only check specific cases or require custom provers.
