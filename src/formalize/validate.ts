import type { SolverType } from "../solvers/types.js";

export interface LintResult {
  /** The spec after auto-fixes have been applied */
  spec: string;
  /** Auto-fixes that were applied */
  fixes: string[];
  /** Remaining errors that need LLM intervention */
  errors: string[];
}

/**
 * Lint and auto-fix a specification before sending to the solver.
 * Fixes what it can, reports what it can't.
 */
export function lintSpec(spec: string, solver: SolverType): LintResult {
  const fixes: string[] = [];
  const errors: string[] = [];
  let cleaned = spec;

  // ── Auto-fixes (applied silently) ──────────────────────

  // Strip markdown fences
  const fencePattern = /^```(?:smt-lib|smtlib|smt2?|prolog|pl)?\s*\n?/gm;
  if (fencePattern.test(cleaned)) {
    cleaned = cleaned.replace(fencePattern, "").replace(/^```\s*$/gm, "");
    fixes.push("Stripped markdown code fences");
  }

  // Trim whitespace
  cleaned = cleaned.trim();

  if (!cleaned) {
    errors.push("Specification is empty after cleaning");
    return { spec: cleaned, fixes, errors };
  }

  // Unfilled template slots — cannot auto-fix
  const slotMatches = cleaned.match(/\{\{SLOT:\w+\}\}/g);
  if (slotMatches) {
    errors.push(`Unfilled template slots: ${slotMatches.join(", ")}`);
  }

  if (solver === "z3") {
    ({ spec: cleaned } = lintSmtlib(cleaned, fixes, errors));
  } else {
    ({ spec: cleaned } = lintProlog(cleaned, fixes, errors));
  }

  return { spec: cleaned, fixes, errors };
}

function lintSmtlib(
  spec: string,
  fixes: string[],
  errors: string[],
): { spec: string } {
  let cleaned = spec;

  // Auto-fix: remove (check-sat) and (get-model)
  if (/\(\s*check-sat\s*\)/.test(cleaned)) {
    cleaned = cleaned.replace(/\(\s*check-sat\s*\)/g, "");
    fixes.push("Removed (check-sat) — added automatically by the solver");
  }
  if (/\(\s*get-model\s*\)/.test(cleaned)) {
    cleaned = cleaned.replace(/\(\s*get-model\s*\)/g, "");
    fixes.push("Removed (get-model) — added automatically by the solver");
  }
  if (/\(\s*exit\s*\)/.test(cleaned)) {
    cleaned = cleaned.replace(/\(\s*exit\s*\)/g, "");
    fixes.push("Removed (exit)");
  }

  // Auto-fix: remove (set-logic ...) — our solver handles this
  if (/\(\s*set-logic\s+\w+\s*\)/.test(cleaned)) {
    cleaned = cleaned.replace(/\(\s*set-logic\s+\w+\s*\)/g, "");
    fixes.push("Removed (set-logic) — solver selects logic automatically");
  }

  cleaned = cleaned.trim();

  // Check: balanced parentheses
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    // Skip string literals (SMT-LIB uses "" to escape " within strings)
    if (ch === '"') {
      i++;
      while (i < cleaned.length) {
        if (cleaned[i] === '"') {
          if (i + 1 < cleaned.length && cleaned[i + 1] === '"') {
            i += 2; // skip doubled quote
            continue;
          }
          break; // end of string
        }
        i++;
      }
      continue;
    }
    // Skip line comments
    if (ch === ';') {
      while (i < cleaned.length && cleaned[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) {
      errors.push(`Unmatched closing parenthesis at position ${i}`);
      break;
    }
  }
  if (depth > 0) {
    errors.push(`Unbalanced parentheses: ${depth} unclosed`);
  }

  return { spec: cleaned };
}

function lintProlog(
  spec: string,
  _fixes: string[],
  errors: string[],
): { spec: string } {
  const cleaned = spec;

  // Context-aware strip of comments and quoted literals. Naive regex
  // stripping misparses `%` inside atoms as line comments, and `''` inside
  // atoms as quote open/close — both cause false-positive errors.
  const stripped = stripPrologNoise(cleaned).trim();

  if (!stripped) return { spec: cleaned };

  // Check: at least one clause ending with a period
  if (!stripped.includes(".")) {
    errors.push("No clauses ending with a period (.) — all Prolog clauses must end with a period");
  }

  // Check: balanced parentheses
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) {
      errors.push("Unmatched closing parenthesis");
      break;
    }
  }
  if (depth > 0) {
    errors.push(`Unbalanced parentheses: ${depth} unclosed`);
  }

  return { spec: cleaned };
}

/**
 * Remove Prolog comments and quoted literal contents without breaking inside
 * strings/atoms. Replaces quoted literals with an empty placeholder (`''` or
 * `""`) so paren-balance checks still work on the surrounding structure.
 */
function stripPrologNoise(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    // Line comment — only outside quotes
    if (ch === "%") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // Block comment — only outside quotes
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Single-quoted atom
    if (ch === "'") {
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) { i += 2; continue; }
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
      out += "''";
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) { i += 2; continue; }
        if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}
