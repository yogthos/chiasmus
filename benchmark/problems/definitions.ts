// ─── Problem 1: RBAC Policy Conflict Detection ─────────────────

export const rbacRules = {
  roles: ["admin", "editor", "viewer", "auditor"],
  resources: ["documents", "settings", "logs", "billing"],
  rules: [
    { role: "admin", action: "write", resource: "documents", effect: "allow" },
    { role: "admin", action: "read", resource: "billing", effect: "allow" },
    { role: "editor", action: "write", resource: "documents", effect: "allow" },
    { role: "editor", action: "delete", resource: "documents", effect: "deny" },
    { role: "editor", action: "write", resource: "settings", effect: "deny" },
    { role: "auditor", action: "read", resource: "logs", effect: "allow" },
    { role: "auditor", action: "write", resource: "logs", effect: "deny" },
    // Conflict: auditor can read billing (via this rule) but also denied below
    { role: "auditor", action: "read", resource: "billing", effect: "allow" },
    { role: "auditor", action: "read", resource: "billing", effect: "deny" },
    { role: "viewer", action: "read", resource: "documents", effect: "allow" },
  ],
};

// ─── Problem 2: Package Dependency Resolution ──────────────────

export const packageConstraints = {
  packages: {
    "app":       { versions: [1, 2, 3] },
    "framework": { versions: [2, 3, 4, 5] },
    "database":  { versions: [1, 2, 3] },
    "cache":     { versions: [1, 2] },
    "logger":    { versions: [1, 2, 3] },
  },
  requirements: [
    // app requires framework >= 3
    { package: "app", requires: "framework", minVersion: 3 },
    // framework >= 4 requires database >= 2
    { package: "framework", condition: 4, requires: "database", minVersion: 2 },
    // database requires cache
    { package: "database", requires: "cache", minVersion: 1 },
    // cache v2 requires logger >= 2
    { package: "cache", condition: 2, requires: "logger", minVersion: 2 },
    // app v3 requires logger >= 3
    { package: "app", condition: 3, requires: "logger", minVersion: 3 },
  ],
  incompatibilities: [
    // framework 5 incompatible with database 1
    { packageA: "framework", versionA: 5, packageB: "database", versionB: 1 },
    // logger 3 incompatible with cache 1
    { packageA: "logger", versionA: 3, packageB: "cache", versionB: 1 },
  ],
};

// ─── Problem 3: Data Flow Taint Analysis ───────────────────────

export const dataFlowGraph = {
  edges: [
    { from: "http_request", to: "route_handler" },
    { from: "route_handler", to: "auth_middleware" },
    { from: "route_handler", to: "input_validator" },
    { from: "input_validator", to: "sanitizer" },
    { from: "sanitizer", to: "business_logic" },
    { from: "business_logic", to: "db_query" },
    { from: "business_logic", to: "cache_lookup" },
    { from: "auth_middleware", to: "session_store" },
    { from: "route_handler", to: "logger" },
    { from: "logger", to: "file_write" },
    // Bypass path: unsanitized data through a debug endpoint
    { from: "route_handler", to: "debug_handler" },
    { from: "debug_handler", to: "eval_engine" },
  ],
  sources: ["http_request"],
  sinks: ["db_query", "eval_engine", "file_write"],
};

// ─── Problem 4: Workflow State Machine Validation ──────────────

export const workflowStates = {
  initial: "draft",
  states: ["draft", "pending_review", "in_review", "approved", "rejected",
           "published", "archived", "deleted"],
  transitions: [
    { from: "draft", to: "pending_review", action: "submit" },
    { from: "pending_review", to: "in_review", action: "assign_reviewer" },
    { from: "in_review", to: "approved", action: "approve" },
    { from: "in_review", to: "rejected", action: "reject" },
    { from: "rejected", to: "draft", action: "revise" },
    { from: "approved", to: "published", action: "publish" },
    { from: "published", to: "archived", action: "archive" },
    // Note: "deleted" has no incoming transitions (unreachable)
    // Note: "archived" has no outgoing transitions (dead end)
  ],
};

// ─── Problem 5: API Validation Rule Consistency ────────────────

export const validationRules = {
  fields: {
    age: { type: "integer" },
    email_length: { type: "integer" },
    username_length: { type: "integer" },
    role: { type: "enum", values: ["user", "admin", "moderator"] },
  },
  frontend: {
    age: { min: 13, max: 120 },
    email_length: { min: 5, max: 254 },
    username_length: { min: 3, max: 30 },
    // Frontend allows all roles
  },
  backend: {
    age: { min: 18, max: 150 },  // Stricter min (18 vs 13) — gap!
    email_length: { min: 5, max: 320 },
    username_length: { min: 3, max: 20 }, // Stricter max (20 vs 30) — gap!
    // Backend forbids "moderator" role for new signups
  },
};
