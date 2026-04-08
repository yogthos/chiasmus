import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { STARTER_TEMPLATES } from "./starters.js";
import { buildIndex, search } from "./bm25.js";
import type { BM25Index } from "./bm25.js";
import type {
  SkillTemplate,
  SkillMetadata,
  SkillWithMetadata,
  SkillSearchResult,
} from "./types.js";
import type { SolverType } from "../solvers/types.js";
import { getRelatedTemplates, type RelatedTemplate } from "./relationships.js";

export interface SearchOptions {
  domain?: string;
  solver?: SolverType;
  limit?: number;
}

export class SkillLibrary {
  private db: Database.Database;
  private templates: Map<string, SkillTemplate>;
  private searchIndex: BM25Index;
  private templateOrder: string[]; // maps BM25 doc index to template name

  private constructor(db: Database.Database, templates: Map<string, SkillTemplate>) {
    this.db = db;
    this.templates = templates;

    // Build search index from template text
    this.templateOrder = [...templates.keys()];
    const searchTexts = this.templateOrder.map((name) => {
      const t = templates.get(name)!;
      return [
        t.name,
        t.domain,
        t.signature,
        ...t.slots.map((s) => s.description),
        ...t.normalizations.map((n) => `${n.source} ${n.transform}`),
      ].join(" ");
    });
    this.searchIndex = buildIndex(searchTexts);
  }

  static async create(basePath: string): Promise<SkillLibrary> {
    mkdirSync(basePath, { recursive: true });

    const dbPath = join(basePath, "chiasmus.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_metadata (
        name TEXT PRIMARY KEY,
        reuse_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        promoted INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Load starter templates and ensure metadata rows exist
    const templates = new Map<string, SkillTemplate>();
    const upsert = db.prepare(`
      INSERT INTO skill_metadata (name, promoted)
      VALUES (?, 1)
      ON CONFLICT(name) DO NOTHING
    `);

    for (const t of STARTER_TEMPLATES) {
      templates.set(t.name, t);
      upsert.run(t.name);
    }

    return new SkillLibrary(db, templates);
  }

  /** List all templates with metadata */
  list(): SkillWithMetadata[] {
    return [...this.templates.values()].map((t) => ({
      template: t,
      metadata: this.loadMetadata(t.name),
    }));
  }

  /** Get a single template by name */
  get(name: string): SkillWithMetadata | null {
    const t = this.templates.get(name);
    if (!t) return null;
    return { template: t, metadata: this.loadMetadata(name) };
  }

  /** Get templates related to the given template */
  getRelated(name: string): RelatedTemplate[] {
    return getRelatedTemplates(name);
  }

  /** Search templates by natural language query */
  search(query: string, options: SearchOptions = {}): SkillSearchResult[] {
    const limit = options.limit ?? 10;
    const hits = search(this.searchIndex, query, this.templates.size);

    const results: SkillSearchResult[] = [];
    for (const hit of hits) {
      const name = this.templateOrder[hit.docIndex];
      const t = this.templates.get(name);
      if (!t) continue;

      if (options.domain && t.domain !== options.domain) continue;
      if (options.solver && t.solver !== options.solver) continue;

      results.push({
        template: t,
        metadata: this.loadMetadata(name),
        score: hit.score,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  /** Record a template use (success or failure) */
  recordUse(name: string, success: boolean): void {
    this.db
      .prepare(
        `UPDATE skill_metadata
         SET reuse_count = reuse_count + 1,
             success_count = success_count + CASE WHEN ? THEN 1 ELSE 0 END,
             last_used = datetime('now')
         WHERE name = ?`
      )
      .run(success ? 1 : 0, name);
  }

  /** Get metadata for a template */
  getMetadata(name: string): SkillMetadata | null {
    return this.loadMetadata(name);
  }

  /** Add a learned (candidate) template to the library. Returns false if name already exists. */
  addLearned(template: SkillTemplate): boolean {
    if (this.templates.has(template.name)) {
      return false; // don't overwrite existing templates
    }

    this.templates.set(template.name, template);

    this.db
      .prepare(
        `INSERT INTO skill_metadata (name, promoted)
         VALUES (?, 0)
         ON CONFLICT(name) DO NOTHING`
      )
      .run(template.name);

    this.rebuildSearchIndex();
    return true;
  }

  /** Promote a candidate template to full status */
  promote(name: string): void {
    this.db
      .prepare("UPDATE skill_metadata SET promoted = 1 WHERE name = ?")
      .run(name);
  }

  /** Remove a template from the library */
  remove(name: string): void {
    this.templates.delete(name);
    this.db.prepare("DELETE FROM skill_metadata WHERE name = ?").run(name);
    this.rebuildSearchIndex();
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  private rebuildSearchIndex(): void {
    this.templateOrder = [...this.templates.keys()];
    const searchTexts = this.templateOrder.map((name) => {
      const t = this.templates.get(name)!;
      return [
        t.name,
        t.domain,
        t.signature,
        ...t.slots.map((s) => s.description),
        ...t.normalizations.map((n) => `${n.source} ${n.transform}`),
      ].join(" ");
    });
    this.searchIndex = buildIndex(searchTexts);
  }

  private loadMetadata(name: string): SkillMetadata {
    const row = this.db
      .prepare("SELECT * FROM skill_metadata WHERE name = ?")
      .get(name) as any;

    if (!row) {
      return {
        name,
        reuseCount: 0,
        successCount: 0,
        lastUsed: null,
        promoted: false,
      };
    }

    return {
      name: row.name,
      reuseCount: row.reuse_count,
      successCount: row.success_count,
      lastUsed: row.last_used,
      promoted: !!row.promoted,
    };
  }
}
