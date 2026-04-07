declare module "tau-prolog" {
  interface PrologSession {
    consult(program: string, callbacks: {
      success: () => void;
      error: (err: PrologTerm) => void;
    }): void;
    query(goal: string, callbacks: {
      success: (goal: PrologTerm) => void;
      error: (err: PrologTerm) => void;
    }): void;
    answer(callbacks: {
      success: (ans: PrologSubstitution) => void;
      fail: () => void;
      error: (err: PrologTerm) => void;
      limit: () => void;
    }): void;
    format_answer(answer: PrologSubstitution | PrologTerm): string;
  }
  interface PrologTerm {
    id?: string;
    args?: PrologTerm[];
    value?: number;
    toString(): string;
  }
  interface PrologSubstitution {
    links: Record<string, PrologTerm>;
    attrs?: Record<string, unknown>;
  }
  function create(limit?: number): PrologSession;
  function format_answer(answer: PrologSubstitution): string;

  const pl: {
    create: typeof create;
    format_answer: typeof format_answer;
  };
  export default pl;
}
