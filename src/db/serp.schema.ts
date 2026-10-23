import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects, rankCheckRuns, rankTrackingConfigs } from "./app.schema";

/**
 * Organic results observed during a rank check (spec 019).
 *
 * The rank check already paid for these results, so they are stored as
 * observed - no new provider call is made. One row per organic position of
 * one keyword, device, market, engine, and rank-check run.
 *
 * `coverageStatus` records whether the provider returned the full inspected
 * top-10 set or only part of it; a partial set is never presented as a full
 * page of results.
 */
export const serpOrganicSnapshots = sqliteTable(
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
