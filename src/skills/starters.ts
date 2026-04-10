import type { SkillTemplate } from "./types.js";

export const STARTER_TEMPLATES: SkillTemplate[] = [
  // ─── Z3 Templates ────────────────────────────────────────

  {
    name: "policy-contradiction",
    domain: "authorization",
    solver: "z3",
    signature:
      "Check if access control rules can ever produce contradictory allow/deny decisions for the same request",
    skeleton: `
; Principals, resources, and actions as enumerated types
{{SLOT:type_declarations}}

(declare-const r {{SLOT:principal_type}})
(declare-const a {{SLOT:action_type}})
(declare-const res {{SLOT:resource_type}})
(declare-const allowed Bool)
(declare-const denied Bool)

; allowed is true IFF the (r, a, res) triple matches ANY allow rule
(assert (= allowed (or {{SLOT:allow_rules}})))

; denied is true IFF the (r, a, res) triple matches ANY deny rule
(assert (= denied (or {{SLOT:deny_rules}})))

; Check: can both be true simultaneously?
(assert allowed)
(assert denied)`,
    slots: [
      {
        name: "type_declarations",
        description: "SMT-LIB declare-datatypes for principals, actions, resources",
        format: "(declare-datatypes ((Role 0)) (((admin) (editor) (viewer))))\n(declare-datatypes ((Action 0)) (((read) (write) (delete))))\n(declare-datatypes ((Resource 0)) (((docs) (settings))))",
      },
      { name: "principal_type", description: "Type name for principals", format: "Role" },
      { name: "action_type", description: "Type name for actions", format: "Action" },
      { name: "resource_type", description: "Type name for resources", format: "Resource" },
      {
        name: "allow_rules",
        description: "OR of all allow conditions — each is (and (= r X) (= a Y) (= res Z))",
        format: "(and (= r admin) (= a read) (= res docs))\n  (and (= r editor) (= a write) (= res docs))",
      },
      {
        name: "deny_rules",
        description: "OR of all deny conditions — each is (and (= r X) (= a Y) (= res Z))",
        format: "(and (= r editor) (= a delete) (= res docs))",
      },
    ],
    normalizations: [
      {
        source: "AWS IAM JSON",
        transform: "Map each Statement's Effect/Principal/Action/Resource to an (and ...) clause",
      },
      {
        source: "Kubernetes RBAC",
        transform: "Expand rules[].{verbs, resources} into (and (= a verb) (= res resource)) clauses",
      },
      {
        source: "natural language",
        transform: "Extract entities, classify as principal/action/resource, build (and ...) clauses",
      },
    ],
    tips: [
      "Use (= flag (or ...)) NOT (=> ... flag) — implication → trivially SAT",
      "No define-fun with args — breaks model. Use declare-const + (assert (=))",
      "Model returns r, a, res = exact conflicting request",
    ],
    example: `(declare-datatypes ((Role 0)) (((admin) (editor))))
(declare-datatypes ((Action 0)) (((read) (write))))
(declare-datatypes ((Resource 0)) (((docs) (billing))))

(declare-const r Role)
(declare-const a Action)
(declare-const res Resource)
(declare-const allowed Bool)
(declare-const denied Bool)

(assert (= allowed (or
  (and (= r admin) (= a read) (= res billing))
  (and (= r editor) (= a write) (= res docs))
)))

(assert (= denied (or
  (and (= r editor) (= a write) (= res docs))
)))

(assert allowed)
(assert denied)`,
  },

  {
    name: "policy-reachability",
    domain: "authorization",
    solver: "z3",
    signature:
      "Check if a specific principal can ever access a specific resource through any combination of roles or rules",
    skeleton: `
{{SLOT:type_declarations}}

(declare-const principal {{SLOT:principal_type}})
(declare-const resource {{SLOT:resource_type}})
(declare-const action {{SLOT:action_type}})
(declare-const can_access Bool)

; Define can_access as true IFF role rules grant it
(assert (= can_access (or {{SLOT:access_rules}})))

; Target: can this specific principal access this specific resource?
(assert (= principal {{SLOT:target_principal}}))
(assert (= resource {{SLOT:target_resource}}))
(assert can_access)`,
    slots: [
      {
        name: "type_declarations",
        description: "SMT-LIB declare-datatypes",
        format: "(declare-datatypes ...)",
      },
      { name: "principal_type", description: "Type name for principals", format: "Principal" },
      { name: "resource_type", description: "Type name for resources", format: "Resource" },
      { name: "action_type", description: "Type name for actions", format: "Action" },
      {
        name: "access_rules",
        description: "OR of conditions that grant access",
        format: "(and (= principal alice) (= action read) (= resource docs))",
      },
      { name: "target_principal", description: "The principal to check", format: "alice" },
      { name: "target_resource", description: "The resource to check", format: "secret_doc" },
    ],
    normalizations: [
      {
        source: "Django permissions",
        transform: "Extract user/group assignments and permission checks into access rule clauses",
      },
      {
        source: "natural language",
        transform: "Identify the target principal and resource, extract role hierarchy",
      },
    ],
    tips: [
      "Use (=) not (=>) for can_access",
      "SAT = access possible | UNSAT = unreachable",
    ],
  },

  {
    name: "config-equivalence",
    domain: "configuration",
    solver: "z3",
    signature:
      "Check if two configurations are functionally equivalent or find an input where they differ",
    skeleton: `
; Input variables representing all possible inputs
{{SLOT:input_declarations}}

; Config A output
(declare-const result_a Bool)
(assert (= result_a {{SLOT:config_a_expr}}))

; Config B output
(declare-const result_b Bool)
(assert (= result_b {{SLOT:config_b_expr}}))

; Check: is there any input where the two configs produce different outputs?
(assert (not (= result_a result_b)))`,
    slots: [
      {
        name: "input_declarations",
        description: "Declare input variables covering the input space",
        format: "(declare-const port Int) (declare-const src_ip Int)",
      },
      {
        name: "config_a_expr",
        description: "Boolean expression for config A's behavior",
        format: "(and (>= port 80) (<= port 443))",
      },
      {
        name: "config_b_expr",
        description: "Boolean expression for config B's behavior",
        format: "(and (>= port 80) (<= port 8080))",
      },
    ],
    normalizations: [
      {
        source: "firewall rules",
        transform: "Encode each rule set as boolean expression over port/protocol/address variables",
      },
      {
        source: "Kubernetes NetworkPolicy",
        transform: "Map ingress/egress rules to boolean expressions over pod labels and ports",
      },
    ],
    tips: [
      "Use (=) to define result vars",
      "SAT = configs differ (model = diverging input) | UNSAT = equivalent",
    ],
    example: `(declare-const port Int)

(declare-const result_a Bool)
(assert (= result_a (and (>= port 80) (<= port 443))))

(declare-const result_b Bool)
(assert (= result_b (and (>= port 80) (<= port 8080))))

(assert (not (= result_a result_b)))`,
  },

  {
    name: "constraint-satisfaction",
    domain: "dependency",
    solver: "z3",
    signature:
      "Find a valid assignment satisfying version constraints, dependency requirements, and compatibility rules",
    skeleton: `
; Version variables for each package
{{SLOT:version_declarations}}

; Version range constraints (available versions)
{{SLOT:range_constraints}}

; Dependency requirements (A requires B >= version)
{{SLOT:dependency_rules}}

; Incompatibility constraints
{{SLOT:incompatibility_rules}}`,
    slots: [
      {
        name: "version_declarations",
        description: "Declare an Int variable for each package version",
        format: "(declare-const pkg_a Int) (declare-const pkg_b Int)",
      },
      {
        name: "range_constraints",
        description: "Constrain each package to its available versions using (or (= pkg v1) (= pkg v2) ...)",
        format: "(assert (or (= pkg_a 1) (= pkg_a 2) (= pkg_a 3)))",
      },
      {
        name: "dependency_rules",
        description: "Conditional version requirements. Use (=>) for 'if pkg_a >= 2 then pkg_b >= 3'",
        format: "(assert (=> (>= pkg_a 2) (>= pkg_b 3)))",
      },
      {
        name: "incompatibility_rules",
        description: "Pairs of versions that cannot coexist",
        format: "(assert (not (and (= pkg_a 2) (= pkg_b 1))))",
      },
    ],
    normalizations: [
      {
        source: "package.json",
        transform: "Parse semver ranges into (or (= pkg v) ...) constraints, map peer deps to (=>) rules",
      },
      {
        source: "requirements.txt",
        transform: "Parse version specifiers (>=, ==, !=) into SMT constraints",
      },
    ],
    tips: [
      "Discrete versions: (or (= pkg 1) (= pkg 2)) not (and (>= 1) (<= 2)) — latter allows non-integers",
      "SAT = valid assignment | UNSAT = no solution",
    ],
    example: `(declare-const app Int)
(declare-const lib Int)
(assert (or (= app 1) (= app 2) (= app 3)))
(assert (or (= lib 1) (= lib 2)))
(assert (=> (>= app 2) (>= lib 2)))
(assert (not (and (= app 3) (= lib 1))))`,
  },

  {
    name: "schema-consistency",
    domain: "validation",
    solver: "z3",
    signature:
      "Check if data validation rules are contradictory, redundant, or have gaps — find inputs that pass some rules but fail others",
    skeleton: `
; Input field variables
{{SLOT:field_declarations}}

; Value passes rule set A
(declare-const passes_a Bool)
(assert (= passes_a (and {{SLOT:rule_set_a_conditions}})))

; Value passes rule set B
(declare-const passes_b Bool)
(assert (= passes_b (and {{SLOT:rule_set_b_conditions}})))

; Check: is there an input that passes A but fails B?
(assert passes_a)
(assert (not passes_b))`,
    slots: [
      {
        name: "field_declarations",
        description: "Declare variables for each input field",
        format: "(declare-const age Int) (declare-const name_len Int)",
      },
      {
        name: "rule_set_a_conditions",
        description: "Conjunction of conditions for rule set A (e.g. frontend validation)",
        format: "(>= age 13) (<= age 120) (>= name_len 3)",
      },
      {
        name: "rule_set_b_conditions",
        description: "Conjunction of conditions for rule set B (e.g. backend validation)",
        format: "(>= age 18) (<= age 150) (>= name_len 3)",
      },
    ],
    normalizations: [
      {
        source: "JSON Schema",
        transform: "Map minimum/maximum/pattern/required to integer/boolean conditions",
      },
      {
        source: "Zod schema",
        transform: "Extract .min()/.max()/.refine() chains into conditions",
      },
    ],
    tips: [
      "Use (=) to define passes_a/passes_b",
      "SAT = gap exists (model = concrete counterexample) | UNSAT = no gap",
      "Swap A/B to check both directions. Per-field: separate check per field.",
    ],
    example: `(declare-const age Int)

(declare-const passes_frontend Bool)
(assert (= passes_frontend (and (>= age 13) (<= age 120))))

(declare-const passes_backend Bool)
(assert (= passes_backend (and (>= age 18) (<= age 150))))

(assert passes_frontend)
(assert (not passes_backend))`,
  },

  // ─── Prolog Templates ────────────────────────────────────

  {
    name: "rule-inference",
    domain: "rules",
    solver: "prolog",
    signature:
      "Given a set of facts and rules, derive what conclusions follow — determine eligibility, compliance, or derived properties",
    skeleton: `
% Facts about entities
{{SLOT:facts}}

% Rules that derive new conclusions
{{SLOT:rules}}`,
    slots: [
      {
        name: "facts",
        description: "Ground facts about the domain",
        format: "role(alice, admin). department(alice, engineering).",
      },
      {
        name: "rules",
        description: "Prolog rules that derive conclusions from facts",
        format: "can_approve(X) :- role(X, admin), department(X, Dept).",
      },
    ],
    normalizations: [
      {
        source: "business rules document",
        transform: "Extract if-then rules and entity facts into Prolog clauses",
      },
      {
        source: "natural language",
        transform: "Identify entities, properties, and conditional relationships",
      },
    ],
    tips: [
      "All clauses end with period. Lowercase = atoms, Uppercase = variables.",
      "No recursive rules on cyclic data — Tau Prolog lacks tabling → infinite loop.",
    ],
  },

  {
    name: "graph-reachability",
    domain: "analysis",
    solver: "prolog",
    signature:
      "Check if node A can reach node B through any path in a directed graph — data flow, dependency chains, call graphs, taint analysis",
    skeleton: `
% Direct edges in the graph
{{SLOT:edges}}

% Direct neighbor query (use for individual checks)
neighbor(A, B) :- edge(A, B).`,
    slots: [
      {
        name: "edges",
        description: "Direct edges as edge(from, to) facts",
        format: "edge(user_input, handler). edge(handler, database).",
      },
    ],
    normalizations: [
      {
        source: "import graph",
        transform: "Map import statements to edge(importer, imported) facts",
      },
      {
        source: "data flow",
        transform: "Map data transformations to edge(source, sink) facts",
      },
      {
        source: "call graph",
        transform: "Map function calls to edge(caller, callee) facts",
      },
    ],
    tips: [
      "⚠ No recursive reaches/2 on cyclic graphs — infinite loop (no tabling)",
      "Cyclic: query edge(X,Y) individually, BFS externally. DAGs: recursive rule safe.",
    ],
    example: `edge(user_input, handler).
edge(handler, validator).
edge(validator, database).
edge(handler, logger).
neighbor(A, B) :- edge(A, B).`,
  },

  {
    name: "permission-derivation",
    domain: "authorization",
    solver: "prolog",
    signature:
      "Given a role hierarchy and permission assignments, derive what actions a user can perform on which resources",
    skeleton: `
% Role assignments
{{SLOT:role_assignments}}

% Role hierarchy (parent inherits child permissions)
{{SLOT:role_hierarchy}}

% Permission assignments to roles
{{SLOT:permissions}}

% Inheritance logic
has_role(User, Role) :- role(User, Role).
has_role(User, Role) :- role(User, R), inherits(R, Role).
has_role(User, Role) :- role(User, R), inherits(R, Mid), has_role_via(Mid, Role).
has_role_via(Role, Role).
has_role_via(Start, End) :- inherits(Start, Mid), has_role_via(Mid, End).

% Permission check
can(User, Action, Resource) :- has_role(User, Role), permission(Role, Action, Resource).`,
    slots: [
      {
        name: "role_assignments",
        description: "Which users have which roles",
        format: "role(alice, admin). role(bob, editor).",
      },
      {
        name: "role_hierarchy",
        description: "Role inheritance relationships",
        format: "inherits(admin, editor). inherits(editor, viewer).",
      },
      {
        name: "permissions",
        description: "What each role can do",
        format: "permission(viewer, read, docs). permission(editor, write, docs).",
      },
    ],
    normalizations: [
      {
        source: "Django groups/permissions",
        transform: "Map Group→Permission assignments to role/permission facts, group hierarchy to inherits",
      },
      {
        source: "Kubernetes RBAC",
        transform: "Map ClusterRole/Role bindings to role facts, aggregate rules to permission facts",
      },
    ],
    tips: [
      "Role hierarchy must be acyclic — cycles → infinite loop",
      "can(alice, Action, Resource) → enumerate all permissions for user",
    ],
  },

  // ─── Code Review / Bug Finding Templates ─────────────────

  {
    name: "invariant-check",
    domain: "verification",
    solver: "z3",
    signature:
      "Verify that a function's postcondition holds for all inputs satisfying its precondition — find counterexamples where the invariant is violated",
    skeleton: `
; Input variables
{{SLOT:input_declarations}}

; Output / result variables
{{SLOT:result_declarations}}

; Function body: define relationship between inputs and outputs
{{SLOT:function_body}}

; Precondition: constrain the input space
(assert {{SLOT:precondition}})

; Negated postcondition: does an input exist that violates the invariant?
(assert (not {{SLOT:postcondition}}))`,
    slots: [
      {
        name: "input_declarations",
        description: "Declare input variables (the function's parameters)",
        format: "(declare-const x Int) (declare-const y Int)",
      },
      {
        name: "result_declarations",
        description: "Declare output/result variables",
        format: "(declare-const result Int)",
      },
      {
        name: "function_body",
        description: "SMT-LIB assertions defining the input→output relationship (the function's logic)",
        format: "(assert (= result (+ x y)))",
      },
      {
        name: "precondition",
        description: "Boolean expression constraining valid inputs (wrapped as single expression)",
        format: "(and (>= x 0) (>= y 0))",
      },
      {
        name: "postcondition",
        description: "Boolean expression the result should satisfy (will be negated to find violations)",
        format: "(>= result 0)",
      },
    ],
    normalizations: [
      {
        source: "function with docstring",
        transform: "Extract parameter types → declarations, body → function_body, @pre → precondition, @post → postcondition",
      },
      {
        source: "assertion / contract comment",
        transform: "Map assert(condition) to precondition, return value checks to postcondition, local variables to result_declarations",
      },
      {
        source: "natural language",
        transform: "Identify function inputs and outputs, express the precondition as input constraints, postcondition as expected output property",
      },
    ],
    tips: [
      "SAT = invariant violated (model = counterexample input) | UNSAT = invariant holds for all valid inputs",
      "Wrap precondition and postcondition as single boolean expressions using (and ...)",
      "Function body: use (assert (= result expr)) to define the output",
      "Use named assertions (! expr :named label) for clearer UNSAT cores when checking multiple invariants",
    ],
    example: `(declare-const x Int)
(declare-const result Int)

(assert (= result (- x 1)))

(assert (>= x 0))

(assert (not (> result 0)))`,
  },

  {
    name: "state-machine-deadlock",
    domain: "verification",
    solver: "z3",
    signature:
      "Check a state machine for unreachable states, dead states (no outgoing transitions), and conflicting state assignments that cause deadlocks",
    skeleton: `
; State enumeration
{{SLOT:state_declarations}}

; Current and next state variables
(declare-const transition_holds Bool)
(declare-const from {{SLOT:state_type}})
(declare-const to {{SLOT:state_type}})

; Transition relation: valid (from, to) pairs
(assert (= transition_holds (or {{SLOT:transitions}})))

; Check: is this specific transition valid?
(assert (= from {{SLOT:source_state}}))
(assert (= to {{SLOT:target_state}}))`,
    slots: [
      {
        name: "state_declarations",
        description: "SMT-LIB declare-datatypes for all states in the machine",
        format: "(declare-datatypes ((State 0)) (((idle) (running) (done) (error))))",
      },
      {
        name: "state_type",
        description: "Type name for the state enumeration",
        format: "State",
      },
      {
        name: "transitions",
        description: "OR of valid transition pairs — each is (and (= from S1) (= to S2))",
        format: "(and (= from idle) (= to running))\n  (and (= from running) (= to done))",
      },
      {
        name: "source_state",
        description: "The source state to check",
        format: "idle",
      },
      {
        name: "target_state",
        description: "The target state to check reachability for",
        format: "done",
      },
    ],
    normalizations: [
      {
        source: "state diagram / Mermaid",
        transform: "Extract state nodes → declare-datatypes, edges → (and (= from X) (= to Y)) pairs",
      },
      {
        source: "switch/case or if-else chain",
        transform: "Extract state values and transition logic into enumerated transitions",
      },
      {
        source: "natural language",
        transform: "Identify states as enumerated type, transitions as (from, to) pairs, target query",
      },
    ],
    tips: [
      "SAT = transition is valid / state is reachable | UNSAT = unreachable / invalid",
      "To find dead states: enumerate each state as target and check if any transition reaches it",
      "For conflicting assignments: assert two rules set different states on the same variable simultaneously",
      "For multi-step reachability: chain transitions through intermediate state variables",
    ],
    example: `(declare-datatypes ((State 0)) (((draft) (review) (approved) (rejected))))
(declare-const transition_holds Bool)
(declare-const from State)
(declare-const to State)

(assert (= transition_holds (or
  (and (= from draft) (= to review))
  (and (= from review) (= to approved))
  (and (= from review) (= to rejected))
  (and (= from rejected) (= to draft))
)))

(assert (= from draft))
(assert (= to approved))`,
  },

  {
    name: "boundary-condition",
    domain: "verification",
    solver: "z3",
    signature:
      "Check numeric boundaries for off-by-one errors, integer overflow/underflow, and edge cases at domain limits",
    skeleton: `
; Input variables with domain constraints
{{SLOT:input_declarations}}

; Computed result
(declare-const result {{SLOT:result_type}})

; Computation: define result as a function of inputs
(assert (= result {{SLOT:computation}}))

; Domain constraints: valid input ranges
(assert {{SLOT:domain_constraints}})

; Check: does the result violate the expected bound?
(assert {{SLOT:violation_condition}})`,
    slots: [
      {
        name: "input_declarations",
        description: "Declare input variables (loop counters, array indices, numeric parameters)",
        format: "(declare-const i Int) (declare-const len Int)",
      },
      {
        name: "result_type",
        description: "Type of the result variable",
        format: "Int",
      },
      {
        name: "computation",
        description: "Expression computing the result from inputs",
        format: "(+ i 1)",
      },
      {
        name: "domain_constraints",
        description: "Boolean expression constraining valid input ranges (single expression)",
        format: "(and (>= i 0) (< i len) (>= len 1))",
      },
      {
        name: "violation_condition",
        description: "The condition that would indicate a bug (result out of bounds, negative, overflow, etc.)",
        format: "(>= result len)",
      },
    ],
    normalizations: [
      {
        source: "loop with array access",
        transform: "Extract loop variable bounds, array length, index expression, check if index can exceed array bounds",
      },
      {
        source: "arithmetic expression",
        transform: "Extract operands and their ranges, compute result expression, check if result can exceed safe bounds",
      },
      {
        source: "natural language",
        transform: "Identify input variables and their valid ranges, the computation performed, and what would constitute a violation",
      },
    ],
    tips: [
      "SAT = boundary violation exists (model = concrete input that triggers the bug) | UNSAT = safe within given domain",
      "For unsigned overflow: assert inputs >= 0, check if result < 0 or result > MAX",
      "For off-by-one: check if result equals the boundary value (e.g., i == len for array index)",
      "Use (or (= result bound) (> result bound)) to include the exact boundary as a violation",
    ],
    example: `(declare-const a Int)
(declare-const b Int)

(declare-const result Int)
(assert (= result (- a b)))

(assert (and (>= a 0) (>= b 0)))

(assert (< result 0))`,
  },

  {
    name: "association-rule-check",
    domain: "verification",
    solver: "prolog",
    signature:
      "Check if code patterns that should co-occur always appear together — detect missing paired operations like lock/unlock, open/close, init/cleanup",
    skeleton: `
% Observed calls per function
{{SLOT:call_facts}}

% Required co-occurrence pairs (if A appears, B must also appear)
{{SLOT:required_pairs}}

% Check: function has the first of a required pair but not the second
missing_pair(Func, Expected) :-
  required_pair(First, Expected),
  calls(Func, First),
  \\+ calls(Func, Expected).`,
    slots: [
      {
        name: "call_facts",
        description: "Prolog facts of the form calls(Function, Operation) — which function calls which operation",
        format: "calls(handler, lock). calls(handler, read). calls(handler, unlock).",
      },
      {
        name: "required_pairs",
        description: "Prolog facts of the form required_pair(OperationA, OperationB) — B must appear whenever A appears",
        format: "required_pair(lock, unlock). required_pair(open, close).",
      },
    ],
    normalizations: [
      {
        source: "call graph analysis",
        transform: "Convert call graph facts to calls(Func, Operation) format, identify paired operations from naming conventions",
      },
      {
        source: "naming convention patterns",
        transform: "Detect pairs like begin/end, open/close, acquire/release, start/stop from function names",
      },
      {
        source: "natural language",
        transform: "Identify the functions and their operations, specify which operations must always appear together",
      },
    ],
    tips: [
      "This template checks single-function scope: both calls must appear in the same function",
      "Use \\+ calls(Func, X) for negation — checks that X does NOT appear in the function's calls",
      "Add additional rules for cross-function checks using call graph reachability",
      "For compliance rules: add a compliant/1 rule that lists all satisfied checks",
    ],
    example: `calls(handler, lock).
calls(handler, read).
calls(handler, unlock).
calls(bad_handler, lock).
calls(bad_handler, read).

required_pair(lock, unlock).

missing_pair(Func, Expected) :-
  required_pair(First, Expected),
  calls(Func, First),
  \\+ calls(Func, Expected).`,
  },

  {
    name: "collective-classification",
    domain: "analysis",
    solver: "prolog",
    signature:
      "Propagate labels through a call graph — classify functions based on what they call and what calls them, starting from known labeled seeds",
    skeleton: `
% Call graph edges
{{SLOT:call_facts}}

% Seed labels: functions with known properties
{{SLOT:seed_labels}}

% Propagation rule: a function inherits the label if it calls a labeled function
{{SLOT:label}}_prop(Func) :- {{SLOT:label}}(Func).
{{SLOT:label}}_prop(Func) :- calls(Func, Callee), {{SLOT:label}}_prop(Callee).`,
    slots: [
      {
        name: "call_facts",
        description: "Prolog facts of the form calls(Caller, Callee) — the call graph edges",
        format: "calls(handler, db_query). calls(handler, validate).",
      },
      {
        name: "seed_labels",
        description: "Prolog facts of the form label(Function) — functions with known classification",
        format: "sensitive(hash_password). can_fail(db_query).",
      },
      {
        name: "label",
        description: "The label/property name to propagate (used as both predicate name and prefix)",
        format: "sensitive",
      },
    ],
    normalizations: [
      {
        source: "call graph + annotations",
        transform: "Extract calls/2 facts from code, use @deprecated/@sensitive/@security annotations as seed labels",
      },
      {
        source: "code review concerns",
        transform: "Identify functions that should be labeled (e.g., crypto, payment, PII), propagate to callers",
      },
      {
        source: "natural language",
        transform: "Identify the property to track, which functions have it initially, and the call graph structure",
      },
    ],
    tips: [
      "Propagation flows CALLEE → CALLER (callers inherit properties of what they call)",
      "For CALLER → CALLEE propagation, reverse the calls/2 direction in the rule",
      "Multiple labels: duplicate the skeleton for each label with a different predicate name",
      "Add negation to find gaps: unlabeled_but_should_be(Func) :- calls_failing(Func), \\+ has_error_handler(Func).",
      "Keep call graph acyclic in propagation rules or add depth limits — Tau Prolog has no tabling",
    ],
    example: `calls(handle_request, db_query).
calls(handle_request, validate).
calls(db_query, execute_sql).

can_fail(execute_sql).
can_fail(validate).

can_fail_prop(Func) :- can_fail(Func).
can_fail_prop(Func) :- calls(Func, Callee), can_fail_prop(Callee).

needs_handling(Func) :- can_fail_prop(Func), \\+ calls(Func, error_handler).`,
  },

  {
    name: "taint-propagation",
    domain: "analysis",
    solver: "prolog",
    signature:
      "Trace tainted data from sources through data flow to sinks — detect unsanitized paths where untrusted input reaches security-sensitive operations",
    skeleton: `
% Data flow edges
{{SLOT:flow_facts}}

% Taint sources: untrusted input origins
{{SLOT:taint_sources}}

% Sanitizers: functions that clean tainted data
:- dynamic(sanitize/1).
{{SLOT:sanitizers}}

% Sinks: security-sensitive operations
{{SLOT:sinks}}

% Taint propagation: tainted if source or flows from tainted through unsanitized path
tainted(X) :- taint_source(X, _).
tainted(Y) :- flows(X, Y), tainted(X), \\+ sanitize(X).

% Violation: tainted data reaching a sink
violation(Sink) :- tainted(Sink), sink(Sink).`,
    slots: [
      {
        name: "flow_facts",
        description: "Prolog facts of the form flows(From, To) — data flow from one function/variable to another",
        format: "flows(user_input, parse). flows(parse, query_builder).",
      },
      {
        name: "taint_sources",
        description: "Prolog facts of the form taint_source(Node, TaintType) — origins of untrusted data",
        format: "taint_source(user_input, user_data). taint_source(cookie, session_data).",
      },
      {
        name: "sanitizers",
        description: "Prolog facts of the form sanitize(Node) — functions that clean/escape tainted data",
        format: "sanitize(escape_html). sanitize(parameterize_query).",
      },
      {
        name: "sinks",
        description: "Prolog facts of the form sink(Node) — security-sensitive operations that must not receive tainted data",
        format: "sink(execute_sql). sink(http_response).",
      },
    ],
    normalizations: [
      {
        source: "call graph analysis",
        transform: "Map calls(Func, Callee) to flows(Func, Callee), identify user-facing functions as taint sources, database/response functions as sinks",
      },
      {
        source: "web framework route analysis",
        transform: "Map request params → taint sources, template rendering → sinks, validation/escaping → sanitizers",
      },
      {
        source: "natural language",
        transform: "Identify where untrusted data enters, where it flows, what cleans it, and where it should never reach",
      },
    ],
    tips: [
      "Taint flows FORWARD: from source through intermediate functions to sink",
      "sanitize(X) stops propagation: nodes AFTER a sanitizer are NOT tainted",
      "Query tainted(X) to see all tainted nodes, violation(X) to see actual security issues",
      "For multi-path analysis: a node is tainted if ANY incoming path is unsanitized",
      "Keep flow graph acyclic or add visited-list tracking — Tau Prolog has no tabling",
    ],
    example: `flows(user_input, parse).
flows(parse, validate).
flows(validate, query_build).
flows(query_build, execute_sql).
flows(user_input, log).

taint_source(user_input, injection).

sanitize(validate).

sink(execute_sql).
sink(log).

tainted(X) :- taint_source(X, _).
tainted(Y) :- flows(X, Y), tainted(X), \\+ sanitize(X).

violation(Sink) :- tainted(Sink), sink(Sink).`,
  },
];
