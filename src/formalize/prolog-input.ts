/**
 * Shared utility for extracting a Prolog query from a spec string.
 * Looks for the last line starting with "?-" and separates program from query.
 */
export function extractPrologQuery(
  spec: string,
): { program: string; query: string } {
  const lines = spec.split("\n");
  let program = spec;
  let query = "true.";

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("?-")) {
      query = trimmed.replace(/^\?\-\s*/, "");
      program = lines.slice(0, i).join("\n").trim();
      break;
    }
  }

  return { program, query };
}
