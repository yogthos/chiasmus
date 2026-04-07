import type { SolverType } from "../solvers/types.js";

/** A slot in a template skeleton that must be filled */
export interface SlotDef {
  /** Slot name, matches {{SLOT:name}} in skeleton */
  name: string;
  /** What this slot expects */
  description: string;
  /** Expected format/type hint */
  format: string;
}

/** A normalization recipe for mapping domain inputs to slot values */
export interface Normalization {
  /** What kind of input this handles */
  source: string;
  /** How to transform it */
  transform: string;
}

/** A reusable formalization template */
export interface SkillTemplate {
  /** Unique identifier */
  name: string;
  /** Problem domain (authorization, configuration, dependency, validation, rules, analysis) */
  domain: string;
  /** Which solver this targets */
  solver: SolverType;
  /** Natural language description for search/matching */
  signature: string;
  /** The formal spec with {{SLOT:name}} markers */
  skeleton: string;
  /** Slots that need to be filled */
  slots: SlotDef[];
  /** Known normalization recipes */
  normalizations: Normalization[];
}

/** Runtime metadata tracked per template */
export interface SkillMetadata {
  name: string;
  reuseCount: number;
  successCount: number;
  lastUsed: string | null;
  promoted: boolean;
}

/** Template with its metadata attached */
export interface SkillWithMetadata {
  template: SkillTemplate;
  metadata: SkillMetadata;
}

/** Search result from the skill library */
export interface SkillSearchResult {
  template: SkillTemplate;
  metadata: SkillMetadata;
  score: number;
}
