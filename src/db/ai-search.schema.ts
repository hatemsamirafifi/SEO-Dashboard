import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

/**
 * AI search observations (spec 020).
 *
 * Privacy: the user's prompt and the model's answer are never stored. A run
 * keeps the hash of the prompt and the content hash of the answer, so the same
 * observation is recorded once and the rows cannot be read back as the user's
 * text. Only counts, hashes, and sanitized URLs are persisted.
 */
export const aiSearchRuns = sqliteTable(
  "ai_search_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelName: text("model_name"),
    /** Hash of the normalized prompt - never the prompt itself. */
    promptHash: text("prompt_hash").notNull(),
    promptLength: integer("prompt_length").notNull(),
    webSearch: integer("web_search", { mode: "boolean" }).notNull(),
    countryCode: text("country_code"),
    outputTokens: integer("output_tokens"),
    fanOutCount: integer("fan_out_count").notNull().default(0),
    citationCount: integer("citation_count").notNull().default(0),
    status: text("status", { enum: ["success"] }).notNull().default("success"),
    /** Content hash of the observed answer: the same observation once. */
    eventKey: text("event_key").notNull(),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("ai_search_runs_project_observed_idx").on(
      table.projectId,
      table.observedAt,
    ),
    index("ai_search_runs_project_model_idx").on(table.projectId, table.model),
    uniqueIndex("ai_search_runs_event_model_idx").on(
      table.projectId,
      table.eventKey,
      table.model,
    ),
  ],
);

export const aiSearchCitations = sqliteTable(
  "ai_search_citations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => aiSearchRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Sanitized http(s) URL of the cited page. */
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    /** Position of the citation inside the answer (1 = first). */
    position: integer("position").notNull(),
    citedAt: text("cited_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_search_citations_run_url_idx").on(table.runId, table.url),
    index("ai_search_citations_project_cited_idx").on(
      table.projectId,
      table.citedAt,
    ),
  ],
);
