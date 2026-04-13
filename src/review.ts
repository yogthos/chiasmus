/**
 * Code review plan builder.
 *
 * Returns a structured, phased recipe that tells the calling LLM exactly which
 * chiasmus tools and templates to invoke, in what order, and what to look for.
 * No I/O, no solver calls — purely a prompt/scaffold.
 */

export type ReviewFocus =
  | "all"
  | "security"
  | "architecture"
  | "correctness"
  | "quick";

export interface ReviewRequest {
  files: string[];
  focus?: ReviewFocus;
  entry_points?: string[];
  /**
   * When set, a PR-delta phase runs first: the current extracted graph is
   * diffed against the named snapshot (typically "main"), and the changed
   * symbols become the recommended focus of subsequent phases. Requires
   * that a snapshot with this name was previously saved via
   * chiasmus_graph save_snapshot=<name>.
   */
  delta_against?: string;
}

export interface ReviewAction {
  tool:
    | "chiasmus_graph"
    | "chiasmus_formalize"
    | "chiasmus_verify"
    | "chiasmus_skills"
    | "chiasmus_lint";
  args: Record<string, unknown>;
  interpret: string;
}

export interface ReviewPhase {
  phase: string;
  goal: string;
  actions: ReviewAction[];
}

export interface SuggestedTemplate {
  template: string;
  when: string;
  workflow: string;
}

export interface ReviewReporting {
  format: string;
  severityLevels: string[];
  instructions: string;
}

export interface ReviewPlan {
  files: string[];
  focus: ReviewFocus;
  summary: string;
  phases: ReviewPhase[];
  suggestedTemplates: SuggestedTemplate[];
  reporting: ReviewReporting;
}

const VALID_FOCUS: ReadonlySet<ReviewFocus> = new Set([
  "all",
  "security",
  "architecture",
  "correctness",
  "quick",
]);

export function buildReviewPlan(request: ReviewRequest): ReviewPlan {
  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new Error("'files' must be a non-empty array of absolute paths");
  }
  const focus: ReviewFocus = request.focus ?? "all";
  if (!VALID_FOCUS.has(focus)) {
    throw new Error(
      `Unknown focus: ${focus}. Use one of: ${[...VALID_FOCUS].join(", ")}`,
    );
  }

  const { files, entry_points, delta_against } = request;

  const phaseOverview = makeOverviewPhase(files);
  const phaseArchitecture = makeArchitecturePhase(files, entry_points);
  const phaseSecurity = makeSecurityPhase(files);
  const phaseResource = makeResourceSafetyPhase(files);
  const phaseAuthorization = makeAuthorizationPhase();
  const phaseCorrectness = makeCorrectnessPhase();
  const phaseImpact = makeImpactPhase(files);

  const phases: ReviewPhase[] = [];
  switch (focus) {
    case "quick":
      phases.push(phaseOverview, phaseArchitecture);
      break;
    case "architecture":
      phases.push(phaseOverview, phaseArchitecture, phaseImpact);
      break;
    case "security":
      phases.push(phaseOverview, phaseSecurity, phaseResource, phaseAuthorization);
      break;
    case "correctness":
      phases.push(phaseOverview, phaseCorrectness, phaseImpact);
      break;
    case "all":
    default:
      phases.push(
        phaseOverview,
        phaseArchitecture,
        phaseSecurity,
        phaseResource,
        phaseAuthorization,
        phaseCorrectness,
        phaseImpact,
      );
      break;
  }

  if (delta_against) {
    phases.unshift(makeDeltaPhase(files, delta_against));
  }

  return {
    files,
    focus,
    summary: buildSummary(focus, phases.length),
    phases,
    suggestedTemplates: pickSuggestedTemplates(focus),
    reporting: buildReporting(delta_against),
  };
}

function buildSummary(focus: ReviewFocus, phaseCount: number): string {
  return (
    `Code review plan (focus: ${focus}) with ${phaseCount} phases. ` +
    `Execute phases in order. For each action, call the named tool with the given args, ` +
    `then apply the 'interpret' guidance to decide whether to flag the result as an issue. ` +
    `After all phases, produce the final report per the 'reporting' section.`
  );
}

function makeDeltaPhase(files: string[], against: string): ReviewPhase {
  return {
    phase: "0. PR delta scope",
    goal:
      "Compare the current code against a previously saved snapshot (usually the base branch) " +
      "to identify which symbols this PR adds, removes, or rewires. The delta drives the later " +
      "phases — expensive analyses (taint, invariant checks, impact) focus on changed symbols " +
      "instead of the entire codebase. Cross-module rewiring flagged here is frequently the " +
      "root cause of regressions.",
    actions: [
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "diff", against, cache: true },
        interpret:
          `Returns { addedNodes, removedNodes, addedEdges, removedEdges, summary }. Requires a ` +
          `snapshot named '${against}' to exist (created earlier via chiasmus_graph save_snapshot='${against}' on the base branch). ` +
          `If the result is { error: 'Snapshot ... not found' }, ask the user to run a baseline extraction first, then skip this phase. ` +
          `Treat every name in addedNodes as a primary review target for the later phases — pass them as focus targets where applicable. ` +
          `Each addedEdge crossing module boundaries (the surprises analysis identifies these) is a candidate architectural regression: ` +
          `escalate to MEDIUM by default, HIGH if the endpoint is a public API. ` +
          `Each removedNode should be impact-checked against the current graph: if callers outside the PR still reference it, flag CRITICAL (broken symbol).`,
      },
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "impact", target: "<REMOVED_NODE>" },
        interpret:
          "Run this once per entry in removedNodes, substituting the name for <REMOVED_NODE>. " +
          "Non-empty result means the PR deletes a symbol that is still referenced somewhere — " +
          "either the callers were supposed to be updated too (PR is incomplete) or the analysis " +
          "is missing the migration file (double-check file set). Severity: CRITICAL.",
      },
    ],
  };
}

function makeOverviewPhase(files: string[]): ReviewPhase {
  return {
    phase: "1. Structural overview",
    goal:
      "Get a baseline for the scope and shape of the code before deep analysis — function count, " +
      "call edge count, import graph size. Helps you calibrate which later phases are worth running.",
    actions: [
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "summary" },
        interpret:
          "Record files, functions, callEdges, imports, exports. A high callEdges:functions ratio (>5:1) " +
          "suggests tight coupling — expect more layer violations and cycles below. Very low edges may " +
          "mean tree-sitter missed calls (dynamic dispatch, reflection) — adjust expectations.",
      },
    ],
  };
}

function makeArchitecturePhase(
  files: string[],
  entryPoints?: string[],
): ReviewPhase {
  const deadCodeArgs: Record<string, unknown> = { files, analysis: "dead-code" };
  if (entryPoints && entryPoints.length > 0) {
    deadCodeArgs.entry_points = entryPoints;
  }
  return {
    phase: "2. Architecture health",
    goal:
      "Surface structural problems: unreachable functions, circular dependencies, and calls that " +
      "skip abstraction layers. These are objective defects — no judgment calls required.",
    actions: [
      {
        tool: "chiasmus_graph",
        args: deadCodeArgs,
        interpret:
          "Each returned name is a function unreachable from any entry point. Before flagging, " +
          "verify it isn't an exported public API, a test fixture, or a framework hook (e.g. React " +
          "component, Kit-clj handler). Remaining names are candidate deletions — severity: LOW to MEDIUM.",
      },
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "cycles" },
        interpret:
          "Each entry is a function that transitively calls itself. Mutual recursion between modules " +
          "(A → B → A) is the main concern — it signals a tangled dependency that blocks incremental " +
          "refactoring. Severity: MEDIUM. If the cycle spans a module boundary, escalate to HIGH.",
      },
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "layer-violation" },
        interpret:
          "Each entry is a call that skips layers (e.g. handler → db without going through services). " +
          "These violate the intended architecture. Severity: MEDIUM. Only relevant if the codebase " +
          "uses the conventional handlers/services/repositories/db layering — otherwise ignore.",
      },
    ],
  };
}

function makeSecurityPhase(files: string[]): ReviewPhase {
  return {
    phase: "3. Security — data flow and taint",
    goal:
      "Trace untrusted input from entry points to sensitive sinks (SQL, shell, HTTP response, file I/O). " +
      "Any unsanitized path is a candidate injection vulnerability.",
    actions: [
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "facts" },
        interpret:
          "This returns raw Prolog facts for the call graph. Keep the output — you'll reuse the calls/2 " +
          "facts as the 'flow_facts' slot when filling the taint-propagation template below. Alternatively " +
          "use reachability queries directly for simple source→sink checks.",
      },
      {
        tool: "chiasmus_formalize",
        args: { problem: "Trace tainted user input through data flow to sensitive sinks like SQL or HTTP response" },
        interpret:
          "Expected template: taint-propagation. Fill slots: flow_facts from the facts dump above, " +
          "taint_sources with request-param functions (req.body, query, cookie parsers), sanitizers " +
          "with escape/validate/parameterize functions, sinks with execute_sql/exec/eval/writeResponse. " +
          "Then call chiasmus_verify with solver='prolog' and query='violation(X).' — each X is a " +
          "tainted sink reachable without sanitization. Severity: HIGH to CRITICAL.",
      },
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "reachability", from: "<USER_INPUT_FN>", to: "<SINK_FN>" },
        interpret:
          "Optional lightweight check: if you already know a specific source and sink, call this for " +
          "each pair. Replace <USER_INPUT_FN> and <SINK_FN> with actual function names from the summary. " +
          "Returns { reachable: true|false }. Faster than taint-propagation but gives no sanitizer awareness.",
      },
    ],
  };
}

function makeResourceSafetyPhase(files: string[]): ReviewPhase {
  return {
    phase: "4. Resource safety — paired operations",
    goal:
      "Detect leaked resources: functions that acquire without releasing (lock/unlock, open/close, " +
      "begin/commit, init/cleanup). These cause deadlocks, file handle exhaustion, and transaction leaks.",
    actions: [
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "facts" },
        interpret:
          "Reuse the facts dump from phase 3 if already obtained. You need the calls/2 facts showing " +
          "which functions call which operations.",
      },
      {
        tool: "chiasmus_formalize",
        args: { problem: "Check that every lock/open/begin call has a matching unlock/close/commit in the same function" },
        interpret:
          "Expected template: association-rule-check. Fill required_pairs with the paired operations " +
          "relevant to this codebase — look at imports to guess (e.g. mutex.lock → mutex.unlock, " +
          "fs.open → fs.close, db.begin → db.commit, ctx.acquire → ctx.release). Then chiasmus_verify " +
          "with query='missing_pair(Func, Expected).' — each answer is a function missing the pair. " +
          "Severity: HIGH for locks/transactions, MEDIUM for file handles.",
      },
    ],
  };
}

function makeAuthorizationPhase(): ReviewPhase {
  return {
    phase: "5. Authorization — policy contradictions",
    goal:
      "If the codebase has RBAC, ACL, or any allow/deny rule set, verify no (principal, action, resource) " +
      "triple can be both allowed and denied. Only run this phase if the codebase actually contains " +
      "authorization logic — skip if there's no policy table or permission check to analyze.",
    actions: [
      {
        tool: "chiasmus_formalize",
        args: { problem: "Check if access control allow/deny rules can ever produce contradictory decisions for the same request" },
        interpret:
          "Expected template: policy-contradiction. Extract the allow and deny rules from the code — " +
          "usually a switch, a rule table, or middleware chain. Fill type_declarations with the enum of " +
          "roles/actions/resources you see. Then chiasmus_verify — SAT means a contradictory request " +
          "exists (the model shows the exact conflict). Severity: HIGH.",
      },
      {
        tool: "chiasmus_skills",
        args: { query: "check if a principal can escalate to reach a forbidden resource" },
        interpret:
          "Follow-up: if policy-contradiction returns SAT or the codebase uses role inheritance, also " +
          "apply policy-reachability and permission-derivation templates. The chiasmus_skills search " +
          "returns candidates ranked by BM25.",
      },
    ],
  };
}

function makeCorrectnessPhase(): ReviewPhase {
  return {
    phase: "6. Correctness — invariants, boundaries, state machines",
    goal:
      "Hunt for bugs in specific hotspot functions identified in earlier phases: off-by-one errors, " +
      "overflow, state machine deadlocks, broken postconditions. This phase is function-targeted — " +
      "run it once per suspect function, not once per file.",
    actions: [
      {
        tool: "chiasmus_formalize",
        args: { problem: "Verify a function's postcondition holds for all inputs satisfying its precondition" },
        interpret:
          "Expected template: invariant-check. For each function with non-trivial numeric logic " +
          "(pricing, balance, retry counts, pagination), extract input_declarations, function_body as " +
          "SMT assertions, precondition from input validation, postcondition from the documented or " +
          "expected result property. SAT = counterexample input; UNSAT = invariant holds.",
      },
      {
        tool: "chiasmus_formalize",
        args: { problem: "Check numeric boundary conditions for off-by-one errors and overflow on array indices and loop counters" },
        interpret:
          "Expected template: boundary-condition. Apply to loops, array access, and arithmetic that " +
          "mixes signed/unsigned or bounded types. SAT means the bug is reachable under the given " +
          "domain_constraints — the model shows the triggering input.",
      },
      {
        tool: "chiasmus_formalize",
        args: { problem: "Detect unreachable states and invalid transitions in a state machine" },
        interpret:
          "Expected template: state-machine-deadlock. Only apply if the code has an explicit state " +
          "field (status: 'draft'|'review'|'approved' etc.) and transition logic. Skip otherwise.",
      },
    ],
  };
}

function makeImpactPhase(files: string[]): ReviewPhase {
  return {
    phase: "7. Impact analysis on flagged functions",
    goal:
      "For every function flagged as buggy, insecure, or structurally problematic in earlier phases, " +
      "compute its blast radius. A bug in a widely-called utility is much more severe than the same " +
      "bug in an isolated leaf function. Use this to set final severity.",
    actions: [
      {
        tool: "chiasmus_graph",
        args: { files, analysis: "impact", target: "<FLAGGED_FUNCTION>" },
        interpret:
          "Call this once per flagged function, substituting the name for <FLAGGED_FUNCTION>. Returns " +
          "the full transitive caller set. If >10 callers: escalate severity by one level. If a caller " +
          "is an entry point (HTTP handler, CLI command, scheduled job): escalate by two levels.",
      },
    ],
  };
}

function pickSuggestedTemplates(focus: ReviewFocus): SuggestedTemplate[] {
  const all: Record<string, SuggestedTemplate> = {
    "taint-propagation": {
      template: "taint-propagation",
      when: "User input must not reach SQL, shell, eval, file paths, or HTTP response without sanitization",
      workflow:
        "chiasmus_graph analysis='facts' → chiasmus_formalize problem='taint flow' → fill flow_facts + sources + sinks + sanitizers → chiasmus_verify query='violation(X).'",
    },
    "association-rule-check": {
      template: "association-rule-check",
      when: "Every acquire must have a matching release (lock/unlock, open/close, begin/commit)",
      workflow:
        "chiasmus_graph analysis='facts' → chiasmus_formalize problem='paired operations' → fill required_pairs → chiasmus_verify query='missing_pair(F, E).'",
    },
    "collective-classification": {
      template: "collective-classification",
      when: "Propagate a property (sensitive, can_fail, deprecated) from seed functions through the call graph",
      workflow:
        "chiasmus_graph analysis='facts' → chiasmus_formalize problem='label propagation' → seed labels → chiasmus_verify query='<label>_prop(X).'",
    },
    "policy-contradiction": {
      template: "policy-contradiction",
      when: "Codebase has access-control allow/deny rules that could conflict",
      workflow:
        "chiasmus_formalize problem='policy conflict' → extract rules from code → chiasmus_verify (SAT = conflict)",
    },
    "policy-reachability": {
      template: "policy-reachability",
      when: "Check if a specific principal can reach a sensitive resource via any rule chain",
      workflow:
        "chiasmus_formalize problem='can principal reach resource' → chiasmus_verify",
    },
    "permission-derivation": {
      template: "permission-derivation",
      when: "Codebase uses role hierarchy / inheritance — compute effective permissions",
      workflow:
        "chiasmus_formalize problem='derive inherited permissions' → chiasmus_verify",
    },
    "invariant-check": {
      template: "invariant-check",
      when: "Specific function has a documented or expected postcondition to verify",
      workflow:
        "chiasmus_formalize problem='verify postcondition' → fill function_body + pre + post → chiasmus_verify (SAT = counterexample)",
    },
    "boundary-condition": {
      template: "boundary-condition",
      when: "Loop indices, array access, or numeric arithmetic may over/underflow",
      workflow:
        "chiasmus_formalize problem='boundary check' → fill computation + domain + violation → chiasmus_verify",
    },
    "state-machine-deadlock": {
      template: "state-machine-deadlock",
      when: "Code has explicit state field + transition rules",
      workflow:
        "chiasmus_formalize problem='state reachability' → chiasmus_verify",
    },
    "graph-reachability": {
      template: "graph-reachability",
      when: "Arbitrary graph-reachability question that doesn't fit the built-in chiasmus_graph analyses",
      workflow:
        "chiasmus_formalize problem='reachability' → fill edges → chiasmus_verify",
    },
  };

  switch (focus) {
    case "security":
      return [
        all["taint-propagation"],
        all["association-rule-check"],
        all["policy-contradiction"],
        all["policy-reachability"],
        all["collective-classification"],
      ];
    case "architecture":
      return [all["graph-reachability"], all["collective-classification"]];
    case "correctness":
      return [
        all["invariant-check"],
        all["boundary-condition"],
        all["state-machine-deadlock"],
      ];
    case "quick":
      return [all["graph-reachability"]];
    case "all":
    default:
      return Object.values(all);
  }
}

function buildReporting(deltaAgainst?: string): ReviewReporting {
  const deltaLine = deltaAgainst
    ? "\n  0. **Changes in this PR**: lead with the graph_diff summary from phase 0 — added " +
      "symbols, removed symbols, rewired edges. Reviewers should open with what changed before " +
      "hearing about every defect.\n"
    : "";
  return {
    format: "Numbered issue list with severity",
    severityLevels: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"],
    instructions:
      "After executing all phases, produce a final report. Structure:\n" +
      deltaLine +
      "  1. **Summary**: one-paragraph overview of the codebase and the review scope.\n" +
      "  2. **Issues**: numbered list, each with: (a) severity label, (b) file:line reference, " +
      "(c) which chiasmus tool/template surfaced it, (d) concrete evidence (model, violating input, " +
      "call chain), (e) suggested fix.\n" +
      "  3. **Clean areas**: briefly note phases that found nothing — explicit negative results are " +
      "valuable.\n" +
      "Severity guide: CRITICAL = exploitable security bug or data loss path; HIGH = correctness " +
      "bug affecting production paths or architecture violation spanning modules; MEDIUM = localized " +
      "bug or layer violation inside a module; LOW = dead code or cosmetic structural issue; " +
      "INFO = observations that aren't defects.",
  };
}
