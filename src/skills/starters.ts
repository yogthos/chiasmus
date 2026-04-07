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

; Decision variables
(declare-const principal {{SLOT:principal_type}})
(declare-const resource {{SLOT:resource_type}})
(declare-const action {{SLOT:action_type}})
(declare-const allowed Bool)
(declare-const denied Bool)

; Policy rules
{{SLOT:policy_rules}}

; Check: can both allowed and denied be true simultaneously?
(assert allowed)
(assert denied)`,
    slots: [
      {
        name: "type_declarations",
        description: "SMT-LIB declare-datatypes for principals, resources, actions",
        format: "(declare-datatypes ((Principal 0)) (((alice) (bob) ...)))",
      },
      {
        name: "principal_type",
        description: "The type name for principals",
        format: "Principal",
      },
      {
        name: "resource_type",
        description: "The type name for resources",
        format: "Resource",
      },
      {
        name: "action_type",
        description: "The type name for actions",
        format: "Action",
      },
      {
        name: "policy_rules",
        description:
          "Implications mapping (principal, resource, action) to allowed/denied",
        format: "(assert (=> (and (= principal alice) (= action read)) allowed))",
      },
    ],
    normalizations: [
      {
        source: "AWS IAM JSON",
        transform:
          "Map each Statement's Effect/Principal/Action/Resource to allow/deny implications",
      },
      {
        source: "Kubernetes RBAC",
        transform:
          "Expand rules[].{verbs, resources, apiGroups} into action/resource allow implications",
      },
      {
        source: "natural language",
        transform: "Extract entities, classify as principal/resource/action, map to implications",
      },
    ],
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

; Role assignments and permission rules
{{SLOT:role_rules}}

; Target: can this specific principal access this specific resource?
(assert (= principal {{SLOT:target_principal}}))
(assert (= resource {{SLOT:target_resource}}))
(assert can_access)`,
    slots: [
      {
        name: "type_declarations",
        description: "SMT-LIB declare-datatypes for principals, resources, actions",
        format: "(declare-datatypes ...)",
      },
      { name: "principal_type", description: "Type name for principals", format: "Principal" },
      { name: "resource_type", description: "Type name for resources", format: "Resource" },
      { name: "action_type", description: "Type name for actions", format: "Action" },
      {
        name: "role_rules",
        description: "Rules that derive can_access from roles and permissions",
        format: "(assert (=> (and (= principal alice) ...) can_access))",
      },
      { name: "target_principal", description: "The principal to check", format: "alice" },
      { name: "target_resource", description: "The resource to check", format: "secret_doc" },
    ],
    normalizations: [
      {
        source: "Django permissions",
        transform: "Extract user/group assignments and permission checks into role rules",
      },
      {
        source: "natural language",
        transform: "Identify the target principal and resource, extract role hierarchy",
      },
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

; Output of config A
{{SLOT:config_a_logic}}

; Output of config B
{{SLOT:config_b_logic}}

; Check: is there any input where the two configs produce different outputs?
(assert (not (= {{SLOT:output_a}} {{SLOT:output_b}})))`,
    slots: [
      {
        name: "input_declarations",
        description: "Declare input variables covering the input space",
        format: "(declare-const port Int) (declare-const src_ip Int)",
      },
      {
        name: "config_a_logic",
        description: "Assertions encoding the first configuration's behavior",
        format: "(declare-const result_a Bool) (assert (=> (> port 80) result_a))",
      },
      {
        name: "config_b_logic",
        description: "Assertions encoding the second configuration's behavior",
        format: "(declare-const result_b Bool) (assert (=> (>= port 80) result_b))",
      },
      { name: "output_a", description: "Output variable from config A", format: "result_a" },
      { name: "output_b", description: "Output variable from config B", format: "result_b" },
    ],
    normalizations: [
      {
        source: "firewall rules",
        transform:
          "Encode each rule set as boolean logic over port/protocol/address variables",
      },
      {
        source: "Kubernetes NetworkPolicy",
        transform: "Map ingress/egress rules to boolean expressions over pod labels and ports",
      },
    ],
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
        description: "Constrain each package to its available version range",
        format: "(assert (and (>= pkg_a 1) (<= pkg_a 3)))",
      },
      {
        name: "dependency_rules",
        description: "Conditional version requirements between packages",
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
        transform:
          "Parse semver ranges into integer constraints, map peer/optional deps to conditional rules",
      },
      {
        source: "requirements.txt",
        transform: "Parse version specifiers (>=, ==, !=) into SMT constraints",
      },
    ],
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

; Validation rule set A
{{SLOT:rule_set_a}}

; Validation rule set B
{{SLOT:rule_set_b}}

; Check: is there an input that passes A but fails B (or vice versa)?
(assert (and {{SLOT:passes_a}} (not {{SLOT:passes_b}})))`,
    slots: [
      {
        name: "field_declarations",
        description: "Declare variables for each input field",
        format: "(declare-const age Int) (declare-const name_len Int)",
      },
      {
        name: "rule_set_a",
        description: "Assertions for the first set of validation rules",
        format: "(declare-const valid_a Bool) (assert (=> (and (>= age 18) ...) valid_a))",
      },
      {
        name: "rule_set_b",
        description: "Assertions for the second set of validation rules",
        format: "(declare-const valid_b Bool) (assert (=> (and (> age 17) ...) valid_b))",
      },
      { name: "passes_a", description: "Variable indicating input passes rule set A", format: "valid_a" },
      { name: "passes_b", description: "Variable indicating input passes rule set B", format: "valid_b" },
    ],
    normalizations: [
      {
        source: "JSON Schema",
        transform:
          "Map minimum/maximum/pattern/required to integer/boolean constraints",
      },
      {
        source: "Zod schema",
        transform: "Extract .min()/.max()/.refine() chains into SMT assertions",
      },
    ],
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
  },

  {
    name: "graph-reachability",
    domain: "analysis",
    solver: "prolog",
    signature:
      "Check if node A can reach node B through any path in a directed graph — data flow, dependency chains, call graphs",
    skeleton: `
% Direct edges in the graph
{{SLOT:edges}}

% Transitive reachability
reaches(A, B) :- edge(A, B).
reaches(A, B) :- edge(A, Mid), reaches(Mid, B).`,
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
        transform:
          "Map data transformations to edge(source, sink) facts",
      },
      {
        source: "call graph",
        transform: "Map function calls to edge(caller, callee) facts",
      },
    ],
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
        transform:
          "Map Group→Permission assignments to role/permission facts, group hierarchy to inherits",
      },
      {
        source: "Kubernetes RBAC",
        transform:
          "Map ClusterRole/Role bindings to role facts, aggregate rules to permission facts",
      },
    ],
  },
];
