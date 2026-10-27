import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * AI search observations (spec 020) - mirrors src/db/ai-search.schema.ts.
 * The prompt and the answer are never stored: only hashes, counts, and
 * sanitized URLs.
 */
export const aiSearchRuns = pgTable(
  "ai_search_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelName: text("model_name"),
    promptHash: text("prompt_hash").notNull(),
    promptLength: integer("prompt_length").notNull(),
    webSearch: boolean("web_search").notNull(),
    countryCode: text("country_code"),
    outputTokens: integer("output_tokens"),
    fanOutCount: integer("fan_out_count").notNull().default(0),
    citationCount: integer("citation_count").notNull().default(0),
    status: text("status", { enum: ["success"] }).notNull().default("success"),
    eventKey: text("event_key").notNull(),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
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

export const aiSearchCitations = pgTable(
  "ai_search_citations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => aiSearchRuns.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    position: integer("position").notNull(),
    citedAt: text("cited_at").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ai_search_citations_run_url_idx").on(table.runId, table.url),
    index("ai_search_citations_project_cited_idx").on(
      table.projectId,
      table.citedAt,
    ),
  ],
);
