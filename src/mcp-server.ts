#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverAdapters } from "./graph/adapter-registry.js";
import { loadConfig } from "./config.js";
import { SolverSession } from "./solvers/session.js";
import { SkillLibrary } from "./skills/library.js";
import { FormalizationEngine } from "./formalize/engine.js";
import { SkillLearner } from "./skills/learner.js";
import { lintSpec } from "./formalize/validate.js";
import { createLLMFromEnv } from "./llm/anthropic.js";
import type { LLMAdapter } from "./llm/types.js";
import type { SolverResult } from "./solvers/types.js";
import { runAnalysis } from "./graph/analyses.js";
import type { AnalysisType } from "./graph/analyses.js";
import { craftTemplate } from "./skills/craft.js";
import { parseMermaid } from "./graph/mermaid.js";
import type { CraftInput } from "./skills/craft.js";

export function getChiasmusHome(): string {
  return process.env.CHIASMUS_HOME ?? join(homedir(), ".chiasmus");
}

const TOOLS = [
  {
    name: "chiasmus_verify",
    description: `Submit formal logic to solver. Returns verified result.

SOLVERS:
  z3     — SMT-LIB format → SAT + model | UNSAT + unsatCore | error
  prolog — facts/rules + query goal → answers | error

FORMAT (optional, prolog only):
  mermaid — parse Mermaid flowchart/stateDiagram → Prolog facts + reachability rules

Z3 RULES:
  ⚠ UNSAT results include unsatCore — use (assert (! expr :named label)) for readable conflict labels
  ⚠ No (check-sat)/(get-model) — added automatically
  ⚠ Use (= flag (or ...)) NOT (=> ... flag) — implication → trivially SAT
  ⚠ No (define-fun) with args — breaks model extraction. Use (declare-const) + (assert (=)) instead

PROLOG RULES:
  ⚠ All clauses end with period
  ⚠ No recursive reachability on cyclic graphs — Tau Prolog lacks tabling → infinite loop. Query edges individually, BFS externally.
  ⚠ Use "queries" param (JSON array) to batch multiple queries against same program in one call

Z3 EXAMPLE (RBAC conflict):
  (declare-datatypes ((Role 0)) (((admin) (editor))))
  (declare-datatypes ((Action 0)) (((read) (write))))
  (declare-const r Role) (declare-const a Action)
  (declare-const allowed Bool) (declare-const denied Bool)
  (assert (= allowed (or (and (= r admin) (= a read)) (and (= r editor) (= a write)))))
  (assert (= denied (or (and (= r editor) (= a write)))))
  (assert allowed) (assert denied)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        solver: {
          type: "string",
          enum: ["z3", "prolog"],
          description: "Which solver to use: z3 (SMT-LIB) or prolog (ISO Prolog)",
        },
        input: {
          type: "string",
          description:
            "The formal specification. For z3: SMT-LIB format. For prolog: facts and rules.",
        },
        query: {
          type: "string",
          description:
            "Prolog query goal (required for prolog unless queries is set). Must end with period.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Batch mode: array of Prolog query goals. Runs all against same program. Returns array of results.",
        },
        format: {
          type: "string",
          enum: ["mermaid"],
          description:
            "Input format. 'mermaid': parse Mermaid flowchart/stateDiagram → Prolog facts (prolog solver only)",
        },
        explain: {
          type: "boolean",
          description:
            "Prolog only: return derivation trace showing which rules fired (default: false)",
        },
      },
      required: ["solver", "input"],
    },
  },
  {
    name: "chiasmus_skills",
    description: `Search/list formalization templates. Returns skeletons, slots, normalization recipes, usage metadata.

Find template before chiasmus_verify or chiasmus_formalize.
  query: "access control policies conflict" → search
  solver: "prolog" → filter by solver
  name: "policy-contradiction" → exact lookup`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query to find relevant templates",
        },
        name: {
          type: "string",
          description: "Get a specific template by exact name (overrides query)",
        },
        domain: {
          type: "string",
          description: "Filter by domain (authorization, configuration, dependency, validation, rules, analysis)",
        },
        solver: {
          type: "string",
          enum: ["z3", "prolog"],
          description: "Filter by solver type",
        },
      },
    },
  },
  {
    name: "chiasmus_formalize",
    description: `Find best template for problem → return skeleton + slot-filling instructions + tips.

Guided workflow:
  1. chiasmus_formalize → get template + slots + tips
  2. Fill slots using your context
  3. chiasmus_verify → verified result`,
    inputSchema: {
      type: "object" as const,
      properties: {
        problem: {
          type: "string",
          description: "Natural language description of the problem to formalize",
        },
      },
      required: ["problem"],
    },
  },
  {
    name: "chiasmus_solve",
    description: `End-to-end: select template → fill slots → lint → verify → correction loop.

Needs ANTHROPIC_API_KEY | DEEPSEEK_API_KEY | OPENAI_API_KEY. Without key → falls back to chiasmus_formalize.
Returns: verified result + template used + correction history.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        problem: {
          type: "string",
          description: "Natural language description of the problem to solve",
        },
      },
      required: ["problem"],
    },
  },
  {
    name: "chiasmus_learn",
    description: `Extract reusable template from verified solution → add to skill library.

Generalizes concrete spec into parameterized template. Stored as candidate → promoted after 3+ successful reuses.
Needs API key. Flow: chiasmus_verify → chiasmus_learn → template appears in chiasmus_skills.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        solver: {
          type: "string",
          enum: ["z3", "prolog"],
          description: "Which solver was used for the verified spec",
        },
        spec: {
          type: "string",
          description: "The verified formal specification to generalize",
        },
        problem: {
          type: "string",
          description: "Natural language description of the problem that was solved",
        },
      },
      required: ["solver", "spec", "problem"],
    },
  },
  {
    name: "chiasmus_lint",
    description: `Fast structural validation of formal spec without running solver.

Auto-fixes: markdown fences, (check-sat)/(get-model), (set-logic).
Checks: balanced parens, unfilled {{SLOT:}} markers, missing periods (Prolog).
Returns cleaned spec + fixes applied + remaining errors.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        solver: {
          type: "string",
          enum: ["z3", "prolog"],
          description: "Solver type for syntax rules",
        },
        input: {
          type: "string",
          description: "Spec to lint",
        },
      },
      required: ["solver", "input"],
    },
  },
  {
    name: "chiasmus_graph",
    description: `Analyze source code call graphs via tree-sitter + Prolog.

Parse source files → extract call graph → run formal analysis.
Supports: TypeScript, JavaScript, Python, Go, Clojure. Files must be absolute paths.

ANALYSES:
  summary      — overview: files, functions, call edges
  callers      — who calls target? (needs target)
  callees      — what does target call? (needs target)
  reachability — can from reach to? (needs from, to)
  dead-code    — functions unreachable from entry points
  cycles       — circular call dependencies
  path         — call chain from→to (needs from, to)
  impact       — what breaks if target changes? (needs target)
  facts        — raw Prolog facts for custom queries via chiasmus_verify`,
    inputSchema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to analyze",
        },
        analysis: {
          type: "string",
          enum: ["summary", "callers", "callees", "reachability", "dead-code", "cycles", "path", "impact", "facts"],
          description: "Which analysis to run",
        },
        target: {
          type: "string",
          description: "Target function name (for callers, callees, impact)",
        },
        from: {
          type: "string",
          description: "Source function (for reachability, path)",
        },
        to: {
          type: "string",
          description: "Destination function (for reachability, path)",
        },
        entry_points: {
          type: "array",
          items: { type: "string" },
          description: "Entry point function names for dead-code analysis (auto-detects exports if omitted)",
        },
      },
      required: ["files", "analysis"],
    },
  },
  {
    name: "chiasmus_craft",
    description: `Create a new formalization template and add it to the skill library.

The calling LLM designs the template — no API key needed. Describe your problem, then submit a template with a skeleton (formal spec with {{SLOT:name}} markers), slot definitions, and normalization recipes.

After creation, the template appears in chiasmus_skills and chiasmus_formalize.

Validation: checks slot/skeleton consistency, required fields, name uniqueness.
Optional: set test=true with an example to run it through the solver.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Kebab-case unique identifier (e.g. 'api-rate-limit-check')",
        },
        domain: {
          type: "string",
          description: "Problem domain (authorization, configuration, dependency, validation, rules, analysis, or custom)",
        },
        solver: {
          type: "string",
          enum: ["z3", "prolog"],
          description: "Target solver",
        },
        signature: {
          type: "string",
          description: "Natural language description for search/matching",
        },
        skeleton: {
          type: "string",
          description: "Formal spec template with {{SLOT:name}} markers",
        },
        slots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              format: { type: "string" },
            },
            required: ["name", "description", "format"],
          },
          description: "Slot definitions — each must match a {{SLOT:name}} in skeleton",
        },
        normalizations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              transform: { type: "string" },
            },
            required: ["source", "transform"],
          },
          description: "Recipes for mapping domain inputs to slot values",
        },
        tips: {
          type: "array",
          items: { type: "string" },
          description: "Optional solver-specific tips and pitfalls",
        },
        example: {
          type: "string",
          description: "Optional complete worked example with all slots filled",
        },
        test: {
          type: "boolean",
          description: "If true and example provided, run example through solver to validate (default: false)",
        },
      },
      required: ["name", "domain", "solver", "signature", "skeleton", "slots", "normalizations"],
    },
  },
];

async function handleVerify(args: Record<string, unknown>): Promise<CallToolResult> {
  const solver = args.solver;
  let input = args.input as string | undefined;
  const query = args.query as string | undefined;
  const explain = args.explain as boolean | undefined;
  const format = args.format as string | undefined;

  if (typeof solver !== "string" || typeof input !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        error: "Both 'solver' (string) and 'input' (string) are required",
      }) }],
    };
  }

  // Mermaid preprocessing: convert to Prolog facts
  if (format === "mermaid") {
    if (solver !== "prolog") {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "error",
          error: "format='mermaid' is only supported with solver='prolog'",
        }) }],
      };
    }
    input = parseMermaid(input);
  }

  let result: SolverResult;

  try {
    if (solver === "z3") {
      const session = await SolverSession.create("z3");
      try {
        result = await session.solve({ type: "z3", smtlib: input });
      } finally {
        session.dispose();
      }
    } else if (solver === "prolog") {
      const queries = args.queries as string[] | undefined;

      if (queries && Array.isArray(queries) && queries.length > 0) {
        // Validate all items are strings
        if (queries.some((q) => typeof q !== "string")) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "error",
              error: "queries array must contain only strings",
            }) }],
          };
        }
        // Batch mode: run multiple queries against same program
        const session = await SolverSession.create("prolog");
        try {
          const results: SolverResult[] = [];
          for (const q of queries) {
            const r = await session.solve({ type: "prolog", program: input, query: q as string, explain: explain ?? false });
            results.push(r);
            if (r.status === "error") break;
          }
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          };
        } finally {
          session.dispose();
        }
      }

      if (!query) {
        result = {
          status: "error",
          error: "'query' or 'queries' parameter required for prolog solver",
        };
      } else {
        const session = await SolverSession.create("prolog");
        try {
          result = await session.solve({
            type: "prolog",
            program: input,
            query,
            explain: explain ?? false,
          });
        } finally {
          session.dispose();
        }
      }
    } else {
      result = {
        status: "error",
        error: `Unknown solver: ${solver}. Use "z3" or "prolog".`,
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { status: "error", error: `Solver initialization failed: ${msg}` };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function handleSkills(
  library: SkillLibrary,
  args: Record<string, unknown>,
): CallToolResult {
  const name = args.name as string | undefined;
  const query = args.query as string | undefined;
  const domain = args.domain as string | undefined;
  const solver = args.solver as "z3" | "prolog" | undefined;

  if (name) {
    const result = library.get(name);
    if (!result) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Template "${name}" not found` }) }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        ...result,
        related: library.getRelated(name),
      }, null, 2) }],
    };
  }

  if (query) {
    const results = library.search(query, { domain, solver });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }

  let all = library.list();
  if (domain) all = all.filter((s) => s.template.domain === domain);
  if (solver) all = all.filter((s) => s.template.solver === solver);

  return {
    content: [{ type: "text", text: JSON.stringify(all, null, 2) }],
  };
}

async function handleFormalize(
  formalizer: FormalizationEngine,
  library: SkillLibrary,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (typeof args.problem !== "string" || !args.problem) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "The 'problem' parameter (string) is required" }) }],
    };
  }
  const problem = args.problem;

  const result = await formalizer.formalize(problem);
  if (!result) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "No matching template found in the skill library" }) }],
    };
  }
  const suggestions = library.getRelated(result.template.name);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        template: result.template.name,
        solver: result.template.solver,
        domain: result.template.domain,
        instructions: result.instructions,
        suggestions,
      }, null, 2),
    }],
  };
}

async function handleSolve(
  formalizer: FormalizationEngine | null,
  library: SkillLibrary,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (typeof args.problem !== "string" || !args.problem) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "The 'problem' parameter (string) is required" }) }],
    };
  }
  const problem = args.problem;

  // If no LLM configured, fall back to formalize
  if (!formalizer) {
    const dummyEngine = new FormalizationEngine(library, {
      async complete() { return ""; },
    });
    const result = await dummyEngine.formalize(problem);
    if (!result) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "No matching template found in the skill library" }) }],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          fallback: true,
          message: "No ANTHROPIC_API_KEY set. Returning template instructions instead. Fill the slots and use chiasmus_verify.",
          template: result.template.name,
          solver: result.template.solver,
          instructions: result.instructions,
        }, null, 2),
      }],
    };
  }

  const result = await formalizer.solve(problem);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        converged: result.converged,
        rounds: result.rounds,
        templateUsed: result.templateUsed,
        result: result.result,
        answers: result.answers,
        history: result.history.map((h) => ({
          round: h.round,
          status: h.result.status,
          error: h.result.status === "error" ? h.result.error : undefined,
        })),
      }, null, 2),
    }],
  };
}

async function handleLearn(
  learner: SkillLearner | null,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (!learner) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "No ANTHROPIC_API_KEY set. chiasmus_learn requires an LLM for template extraction.",
      }) }],
    };
  }

  if (
    typeof args.solver !== "string" ||
    typeof args.spec !== "string" ||
    typeof args.problem !== "string" ||
    !args.solver || !args.spec || !args.problem
  ) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "Required parameters: solver (string), spec (string), problem (string)",
      }) }],
    };
  }

  const solver = args.solver;
  const spec = args.spec;
  const problem = args.problem;

  if (solver !== "z3" && solver !== "prolog") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown solver: ${solver}. Use "z3" or "prolog".`,
      }) }],
    };
  }

  const result = await learner.extractTemplate(solver, spec, problem);
  if (!result) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        extracted: false,
        reason: "Template was rejected — either invalid, too similar to an existing template, or LLM produced unparseable output",
      }) }],
    };
  }

  // Check promotions after learning
  learner.checkPromotions();

  return {
    content: [{ type: "text", text: JSON.stringify({
      extracted: true,
      template: result.name,
      domain: result.domain,
      solver: result.solver,
      signature: result.signature,
      slots: result.slots.length,
      promoted: false,
    }, null, 2) }],
  };
}

function handleLint(args: Record<string, unknown>): CallToolResult {
  const solver = args.solver;
  const input = args.input;

  if (typeof solver !== "string" || typeof input !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "Required: solver (string), input (string)",
      }) }],
    };
  }

  if (solver !== "z3" && solver !== "prolog") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown solver: ${solver}. Use "z3" or "prolog".`,
      }) }],
    };
  }

  const result = lintSpec(input, solver);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

const VALID_ANALYSES = ["summary", "callers", "callees", "reachability", "dead-code", "cycles", "path", "impact", "facts"];

async function handleGraph(args: Record<string, unknown>): Promise<CallToolResult> {
  const files = args.files;
  const analysis = args.analysis;

  if (!Array.isArray(files) || typeof analysis !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "Required: files (string[]), analysis (string)",
      }) }],
    };
  }

  if (!VALID_ANALYSES.includes(analysis)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: `Unknown analysis: ${analysis}. Use one of: ${VALID_ANALYSES.join(", ")}`,
      }) }],
    };
  }

  try {
    const result = await runAnalysis(files as string[], {
      analysis: analysis as AnalysisType,
      target: args.target as string | undefined,
      from: args.from as string | undefined,
      to: args.to as string | undefined,
      entryPoints: args.entry_points as string[] | undefined,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
}

async function handleCraft(
  library: SkillLibrary,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const input: CraftInput = {
    name: args.name as string ?? "",
    domain: args.domain as string ?? "",
    solver: args.solver as string ?? "",
    signature: args.signature as string ?? "",
    skeleton: args.skeleton as string ?? "",
    slots: args.slots as Array<{ name: string; description: string; format: string }> ?? [],
    normalizations: args.normalizations as Array<{ source: string; transform: string }> ?? [],
    tips: args.tips as string[] | undefined,
    example: args.example as string | undefined,
    test: args.test as boolean | undefined,
  };

  const result = await craftTemplate(input, library);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export async function createChiasmusServer(
  chiasmusHome?: string,
  llmOverride?: LLMAdapter | null,
): Promise<{ server: Server; library: SkillLibrary; formalizer: FormalizationEngine | null }> {
  const home = chiasmusHome ?? getChiasmusHome();
  const config = loadConfig(home);
  if (config.adapterDiscovery) {
    await discoverAdapters();
  }
  const library = await SkillLibrary.create(home);

  // Use override if provided, otherwise try env
  const llm = llmOverride !== undefined ? llmOverride : createLLMFromEnv();
  const formalizer = llm ? new FormalizationEngine(library, llm) : null;
  const learner = llm ? new SkillLearner(library, llm) : null;

  const server = new Server(
    { name: "chiasmus", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // FormalizationEngine for formalize tool (always available, uses dummy LLM for template selection only)
  const formalizeEngine = new FormalizationEngine(library, llm ?? {
    async complete() { return ""; },
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "chiasmus_verify":
        return handleVerify(args ?? {});
      case "chiasmus_skills":
        return handleSkills(library, args ?? {});
      case "chiasmus_formalize":
        return handleFormalize(formalizeEngine, library, args ?? {});
      case "chiasmus_solve":
        return handleSolve(formalizer, library, args ?? {});
      case "chiasmus_learn":
        return handleLearn(learner, args ?? {});
      case "chiasmus_lint":
        return handleLint(args ?? {});
      case "chiasmus_graph":
        return handleGraph(args ?? {});
      case "chiasmus_craft":
        return handleCraft(library, args ?? {});
      default:
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "error", error: `Unknown tool: ${name}` }) },
          ],
        };
    }
  });

  return { server, library, formalizer };
}

// CLI entry point — detect if run directly, via npx bin symlink, or via tsx
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const resolvedArg = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = resolvedArg === thisFile
  || resolvedArg === thisFile.replace(/\.ts$/, ".js")
  || process.argv[1]?.endsWith("mcp-server.ts")
  || process.argv[1]?.endsWith("mcp-server.js");

if (isMain) {
  const { server } = await createChiasmusServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Chiasmus] MCP server running on stdio");
}
