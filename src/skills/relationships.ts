/** A suggestion for a related verification check */
export interface RelatedTemplate {
  name: string;
  reason: string;
}

const RELATIONSHIPS: Record<string, RelatedTemplate[]> = {
  "policy-contradiction": [
    { name: "policy-reachability", reason: "After finding conflicts, verify no principal can escalate to reach conflicting permissions" },
    { name: "permission-derivation", reason: "Check inherited permissions that may cause the detected contradiction" },
  ],
  "policy-reachability": [
    { name: "policy-contradiction", reason: "Reachable policies may contradict each other — check for allow/deny conflicts" },
    { name: "permission-derivation", reason: "Derive the full permission set for reached principals via role hierarchy" },
  ],
  "permission-derivation": [
    { name: "policy-contradiction", reason: "Derived permissions may introduce allow/deny contradictions" },
    { name: "policy-reachability", reason: "Check if derived roles can reach sensitive resources" },
  ],
  "schema-consistency": [
    { name: "config-equivalence", reason: "Inconsistent schemas may indicate divergent configurations worth comparing" },
    { name: "constraint-satisfaction", reason: "Check if the validated constraints can be simultaneously satisfied" },
  ],
  "config-equivalence": [
    { name: "schema-consistency", reason: "Equivalent configs should pass the same validation rules — verify consistency" },
  ],
  "constraint-satisfaction": [
    { name: "schema-consistency", reason: "Satisfied constraints should align with schema validation rules" },
  ],
  "graph-reachability": [
    { name: "rule-inference", reason: "Reachable nodes may trigger inference rules — derive what follows from connectivity" },
  ],
  "rule-inference": [
    { name: "graph-reachability", reason: "Inferred relationships may create new reachability paths in the dependency graph" },
    { name: "permission-derivation", reason: "Rule-based derivations often relate to permission and role hierarchies" },
  ],
  "invariant-check": [
    { name: "boundary-condition", reason: "Invariant violations often occur at boundary values — check numeric edges" },
    { name: "state-machine-deadlock", reason: "State machine invariants may be violated at unexpected transitions" },
  ],
  "state-machine-deadlock": [
    { name: "invariant-check", reason: "Dead states may violate state machine invariants — verify postconditions" },
    { name: "association-rule-check", reason: "State transitions may require co-occurring operations like setup/teardown" },
  ],
  "boundary-condition": [
    { name: "invariant-check", reason: "Boundary violations are a specific form of invariant violation" },
    { name: "schema-consistency", reason: "Boundary conditions may expose gaps between frontend and backend validation" },
  ],
  "association-rule-check": [
    { name: "taint-propagation", reason: "Missing paired operations (like sanitize) may leave taint propagation paths open" },
    { name: "collective-classification", reason: "Co-occurrence patterns help classify functions that need error handling" },
  ],
  "collective-classification": [
    { name: "taint-propagation", reason: "Propagated labels can identify taint sources and sinks via call graph" },
    { name: "association-rule-check", reason: "Classified functions should follow co-occurrence rules for their category" },
  ],
  "taint-propagation": [
    { name: "association-rule-check", reason: "Sanitizers should co-occur with taint sources — verify pairing" },
    { name: "collective-classification", reason: "Tainted functions propagate security labels through the call graph" },
    { name: "graph-reachability", reason: "Taint paths are a specialized form of graph reachability analysis" },
  ],
};

/** Get templates related to the given template name */
export function getRelatedTemplates(templateName: string): RelatedTemplate[] {
  return RELATIONSHIPS[templateName] ?? [];
}
