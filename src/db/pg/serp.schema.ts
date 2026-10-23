import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects, rankCheckRuns, rankTrackingConfigs } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Organic results observed during a rank check (spec 019) - mirrors
 * src/db/serp.schema.ts.
 */
export const serpOrganicSnapshots = pgTable(
  "serp_organic_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    configId: text("config_id")
      .notNull()
      .references(() => rankTrackingConfigs.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    keyword: text("keyword").notNull(),
    searchEngine: text("search_engine").notNull().default("google"),
    locationCode: integer("location_code").notNull(),
    locationName: text("location_name"),
    languageCode: text("language_code").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    position: integer("position").notNull(),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    title: text("title"),
    domain: text("domain"),
    provider: text("provider").notNull(),
    coverageStatus: text("coverage_status", { enum: ["full", "partial"] })
      .notNull()
      .default("full"),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("serp_organic_snapshots_project_market_device_idx").on(
      table.projectId,
      table.locationCode,
      table.languageCode,
      table.device,
    ),
    index("serp_organic_snapshots_project_observed_idx").on(
      table.projectId,
      table.observedAt,
    ),
    index("serp_organic_snapshots_run_idx").on(table.runId),
    uniqueIndex("serp_organic_snapshots_run_keyword_position_idx").on(
      table.runId,
      table.trackingKeywordId,
      table.device,
      table.position,
    ),
  ],
);
