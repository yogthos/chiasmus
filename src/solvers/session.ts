import { randomUUID } from "node:crypto";
import { createZ3Solver } from "./z3-solver.js";
import { createPrologSolver } from "./prolog-solver.js";
import type { Solver, SolverType, SolverInput, SolverResult } from "./types.js";

export class SolverSession {
  readonly id: string;
  readonly solverType: SolverType;
  private solver: Solver;

  private constructor(id: string, solverType: SolverType, solver: Solver) {
    this.id = id;
    this.solverType = solverType;
    this.solver = solver;
  }

  static async create(type: SolverType): Promise<SolverSession> {
    const id = randomUUID();
    const solver =
      type === "z3" ? await createZ3Solver() : createPrologSolver();
    return new SolverSession(id, type, solver);
  }

  async solve(input: SolverInput): Promise<SolverResult> {
    return this.solver.solve(input);
  }

  dispose(): void {
    this.solver.dispose();
  }
}
