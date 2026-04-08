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
import { SolverSession } from "./solvers/session.js";
import { SkillLibrary } from "./skills/library.js";
import { FormalizationEngine } from "./formalize/engine.js";
import { createLLMFromEnv } from "./llm/anthropic.js";
import type { LLMAdapter } from "./llm/types.js";
import type { SolverResult } from "./solvers/types.js";

export function getChiasmusHome(): string {
  return process.env.CHIASMUS_HOME ?? join(homedir(), ".chiasmus");
}

const TOOLS = [
  {
    name: "chiasmus_verify",
    description: `Submit raw formal logic to a solver and get a verified result.

SOLVERS:
  z3      — SMT solver. Input is SMT-LIB format. Returns SAT + model, UNSAT, or error.
  prolog  — ISO Prolog. Input is facts/rules, query is a Prolog goal. Returns answers or error.

WHEN TO USE:
  - Verify constraints: "can these rules ever conflict?"
  - Check satisfiability: "is there a valid assignment?"
  - Prove/disprove: "is this always true for all inputs?"
  - Derive conclusions: "what follows from these facts and rules?"

NOTE: Do NOT include (check-sat) or (get-model) in Z3 input — the tool runs these automatically.

EXAMPLES:
  Z3 (check if two integers sum to 10):
    solver: "z3"
    input: |
      (declare-const x Int)
      (declare-const y Int)
      (assert (= (+ x y) 10))
      (assert (> x 0))
      (assert (> y 0))

  Prolog (derive permissions):
    solver: "prolog"
    input: "role(alice, admin). can_access(X, resource) :- role(X, admin)."
    query: "can_access(alice, resource)."`,
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
            "Prolog query goal (required for prolog, ignored for z3). Must end with a period.",
        },
      },
      required: ["solver", "input"],
    },
  },
  {
    name: "chiasmus_skills",
    description: `Search and list formalization templates in the skill library.

Returns matching templates with their skeletons, slot definitions, normalization recipes,
and usage metadata (reuse count, success rate).

Use this to find an appropriate template before calling chiasmus_verify or chiasmus_solve.

EXAMPLES:
  Search for authorization templates:
    query: "check if access control policies conflict"

  List all Prolog templates:
    solver: "prolog"

  Get a specific template:
    name: "policy-contradiction"`,
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
    description: `Find the best formalization template for a problem and return it with slot-filling instructions.

This is a GUIDED workflow: the tool finds the right template and tells you how to fill it.
You then fill the slots and submit the result via chiasmus_verify.

WORKFLOW:
  1. Call chiasmus_formalize with your problem description
  2. Read the returned template, slots, and normalization guidance
  3. Fill the template slots based on the guidance
  4. Submit the filled specification via chiasmus_verify

Use this when you want full control over the formalization process.`,
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
    description: `End-to-end: formalize a problem and verify it automatically.

Uses an LLM to select a template, fill slots, and run the correction loop.
Requires ANTHROPIC_API_KEY to be set. Without it, falls back to returning
template instructions (same as chiasmus_formalize).

WHEN TO USE:
  - You want a fully automated solve pipeline
  - The problem maps to a known domain (authorization, config, dependency, rules, reachability)

Returns the verified solver result, the template used, and correction loop history.`,
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
];

async function handleVerify(args: Record<string, unknown>): Promise<CallToolResult> {
  const solver = args.solver;
  const input = args.input;
  const query = args.query as string | undefined;

  if (typeof solver !== "string" || typeof input !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        error: "Both 'solver' (string) and 'input' (string) are required",
      }) }],
    };
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
      if (!query) {
        result = {
          status: "error",
          error: "The 'query' parameter is required for the prolog solver",
        };
      } else {
        const session = await SolverSession.create("prolog");
        try {
          result = await session.solve({
            type: "prolog",
            program: input,
            query,
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
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const problem = args.problem as string;
  if (!problem) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "The 'problem' parameter is required" }) }],
    };
  }

  const result = await formalizer.formalize(problem);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        template: result.template.name,
        solver: result.template.solver,
        domain: result.template.domain,
        instructions: result.instructions,
      }, null, 2),
    }],
  };
}

async function handleSolve(
  formalizer: FormalizationEngine | null,
  library: SkillLibrary,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const problem = args.problem as string;
  if (!problem) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "The 'problem' parameter is required" }) }],
    };
  }

  // If no LLM configured, fall back to formalize
  if (!formalizer) {
    const dummyEngine = new FormalizationEngine(library, {
      async complete() { return ""; },
    });
    const result = await dummyEngine.formalize(problem);
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

export async function createChiasmusServer(
  chiasmusHome?: string,
  llmOverride?: LLMAdapter | null,
): Promise<{ server: Server; library: SkillLibrary; formalizer: FormalizationEngine | null }> {
  const home = chiasmusHome ?? getChiasmusHome();
  const library = await SkillLibrary.create(home);

  // Use override if provided, otherwise try env
  const llm = llmOverride !== undefined ? llmOverride : createLLMFromEnv();
  const formalizer = llm ? new FormalizationEngine(library, llm) : null;

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
        return handleFormalize(formalizeEngine, args ?? {});
      case "chiasmus_solve":
        return handleSolve(formalizer, library, args ?? {});
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

// CLI entry point
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("mcp-server.ts") ||
    process.argv[1].endsWith("mcp-server.js"));

if (isMain) {
  const { server } = await createChiasmusServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Chiasmus] MCP server running on stdio");
}
