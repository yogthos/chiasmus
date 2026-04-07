#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { SolverSession } from "./solvers/session.js";
import type { SolverResult } from "./solvers/types.js";

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
];

async function handleVerify(args: Record<string, unknown>): Promise<CallToolResult> {
  const solver = args.solver as string;
  const input = args.input as string;
  const query = args.query as string | undefined;

  let result: SolverResult;

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

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export function createChiasmusServer(): Server {
  const server = new Server(
    { name: "chiasmus", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "chiasmus_verify":
        return handleVerify(args ?? {});
      default:
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "error", error: `Unknown tool: ${name}` }) },
          ],
        };
    }
  });

  return server;
}

// CLI entry point
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("mcp-server.ts") ||
    process.argv[1].endsWith("mcp-server.js"));

if (isMain) {
  const server = createChiasmusServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Chiasmus] MCP server running on stdio");
}
