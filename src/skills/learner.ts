import type { LLMAdapter } from "../llm/types.js";
import type { SkillLibrary } from "./library.js";
import type { SkillTemplate, SlotDef, Normalization } from "./types.js";
import type { SolverType } from "../solvers/types.js";

const PROMOTION_THRESHOLD = 3;
const PROMOTION_SUCCESS_RATE = 0.6;
const DEDUP_SIMILARITY_THRESHOLD = 0.7;

const EXTRACT_SYSTEM = `You are a template extraction engine. Given a verified formal specification and the problem it solved, extract a REUSABLE template.

Your job:
1. Identify which parts are problem-specific (concrete values) vs structural (the pattern)
2. Replace concrete values with {{SLOT:name}} markers
3. Name and describe each slot
4. Write a general signature that describes the class of problems this template solves
5. Suggest normalization recipes for common input formats

Return a JSON object with these fields:
{
  "name": "kebab-case-name",
  "domain": "one of: authorization, configuration, dependency, validation, rules, analysis",
  "signature": "Natural language description of what class of problems this solves",
  "slots": [{ "name": "slot_name", "description": "what goes here", "format": "example" }],
  "normalizations": [{ "source": "input format", "transform": "how to map it" }],
  "skeleton": "the template with {{SLOT:name}} markers"
}

Return ONLY valid JSON, no markdown fences, no explanation.`;

export class SkillLearner {
  constructor(
    private library: SkillLibrary,
    private llm: LLMAdapter,
  ) {}

  /**
   * Extract a reusable template from a verified solution.
   * Returns the template if accepted, null if rejected (duplicate or invalid).
   */
  async extractTemplate(
    solver: SolverType,
    verifiedSpec: string,
    problemDescription: string,
  ): Promise<SkillTemplate | null> {
    const response = await this.llm.complete(EXTRACT_SYSTEM, [
      {
        role: "user",
        content: `SOLVER: ${solver}
VERIFIED SPECIFICATION:
${verifiedSpec}

PROBLEM DESCRIPTION: ${problemDescription}

Extract a reusable template from this verified solution.`,
      },
    ]);

    // Parse LLM response
    const cleaned = response
      .replace(/^```(?:json)?\n?/gm, "")
      .replace(/^```\n?/gm, "")
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    // Validate required fields
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.domain !== "string" ||
      typeof parsed.signature !== "string" ||
      typeof parsed.skeleton !== "string" ||
      !Array.isArray(parsed.slots) ||
      !Array.isArray(parsed.normalizations)
    ) {
      return null;
    }

    const template: SkillTemplate = {
      name: parsed.name,
      domain: parsed.domain,
      solver,
      signature: parsed.signature,
      skeleton: parsed.skeleton,
      slots: (parsed.slots as SlotDef[]).filter(
        (s) =>
          typeof s.name === "string" &&
          typeof s.description === "string" &&
          typeof s.format === "string",
      ),
      normalizations: (parsed.normalizations as Normalization[]).filter(
        (n) => typeof n.source === "string" && typeof n.transform === "string",
      ),
    };

    // Check for duplicates
    if (this.isDuplicate(template)) {
      return null;
    }

    // Add to library as candidate (not promoted)
    this.library.addLearned(template);
    return template;
  }

  /** Check promotions: promote candidates with sufficient reuse and success rate */
  checkPromotions(): void {
    const all = this.library.list();
    for (const item of all) {
      if (item.metadata.promoted) continue;
      if (item.metadata.reuseCount < PROMOTION_THRESHOLD) continue;

      const successRate =
        item.metadata.reuseCount > 0
          ? item.metadata.successCount / item.metadata.reuseCount
          : 0;

      if (successRate >= PROMOTION_SUCCESS_RATE) {
        this.library.promote(item.template.name);
      }
    }
  }

  /** Check if a template is too similar to an existing one */
  private isDuplicate(candidate: SkillTemplate): boolean {
    const results = this.library.search(candidate.signature, { limit: 3 });
    for (const result of results) {
      if (this.textSimilarity(candidate.signature, result.template.signature) > DEDUP_SIMILARITY_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  /** Simple word-overlap similarity (Jaccard) for dedup */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union === 0 ? 0 : intersection / union;
  }
}
