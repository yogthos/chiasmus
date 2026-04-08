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
];
