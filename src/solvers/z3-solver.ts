import { init } from "z3-solver";
import type { Solver, SolverInput, SolverResult } from "./types.js";

// Cache Z3 WASM initialization — it loads ~30MB, should only happen once.
let z3Promise: ReturnType<typeof init> | null = null;

function getZ3() {
  if (!z3Promise) {
    z3Promise = init();
  }
  return z3Promise;
}

/** Strip commands that we handle ourselves to avoid conflicts */
function sanitizeSmtlib(input: string): string {
  return input
    .replace(/\(\s*check-sat\s*\)/g, "")
    .replace(/\(\s*get-model\s*\)/g, "")
    .replace(/\(\s*get-unsat-core\s*\)/g, "")
    .replace(/\(\s*exit\s*\)/g, "")
    .replace(/\(\s*set-option\s+:produce-unsat-cores\s+\w+\s*\)/g, "")
    .trim();
}

export async function createZ3Solver(): Promise<Solver> {
  const z3 = await getZ3();
  const ctx = z3.Context("main");

  let disposed = false;

  return {
    type: "z3",

    async solve(input: SolverInput): Promise<SolverResult> {
      if (input.type !== "z3") {
        return { status: "error", error: "Expected z3 input type" };
      }

      const smtlib = sanitizeSmtlib(input.smtlib);
      if (!smtlib) {
        return { status: "sat", model: {} };
      }

      const solver = new ctx.Solver();
      try {
        solver.fromString(`(set-option :produce-unsat-cores true)\n${smtlib}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "error", error: msg };
      }

      let checkResult: string;
      try {
        checkResult = await solver.check();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "error", error: msg };
      }

      if (checkResult === "unsat") {
        try {
          const coreVector = solver.unsatCore();
          const unsatCore: string[] = [];
          for (let i = 0; i < coreVector.length(); i++) {
            unsatCore.push(coreVector.get(i).sexpr());
          }
          return { status: "unsat", unsatCore };
        } catch {
          return { status: "unsat", unsatCore: [] };
        }
      }

      if (checkResult !== "sat") {
        return { status: "unknown" };
      }

      try {
        const model = solver.model();
        const assignments: Record<string, string> = {};
        for (const decl of model.decls()) {
          assignments[decl.name()] = model.eval(decl.call()).toString();
        }
        return { status: "sat", model: assignments };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "error", error: `Model extraction failed: ${msg}` };
      }
    },

    dispose() {
      if (!disposed) {
        disposed = true;
      }
    },
  };
}
