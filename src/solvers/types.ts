/** Identifies which solver engine to use */
export type SolverType = "z3" | "prolog";

/** Result of a solver execution */
export type SolverResult =
  | { status: "sat"; model: Record<string, string> }
  | { status: "unsat"; unsatCore?: string[] }
  | { status: "unknown" }
  | { status: "success"; answers: PrologAnswer[]; trace?: string[] }
  | { status: "error"; error: string };

/** A single Prolog query answer: variable bindings */
export interface PrologAnswer {
  bindings: Record<string, string>;
  formatted: string;
}

/** Common interface for all solver backends */
export interface Solver {
  readonly type: SolverType;

  /**
   * Execute a formal specification and return a structured result.
   * For Z3: input is SMT-LIB format.
   * For Prolog: input is { program, query }.
   */
  solve(input: SolverInput): Promise<SolverResult>;

  /** Clean up any resources held by this solver instance */
  dispose(): void;
}

/** Input to a solver */
export type SolverInput =
  | { type: "z3"; smtlib: string }
  | { type: "prolog"; program: string; query: string; explain?: boolean };
