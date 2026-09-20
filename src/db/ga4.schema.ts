import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

export const ga4Connections = sqliteTable(
  "ga4_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    propertyDisplayName: text("property_display_name").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    ga4AccountId: text("ga4_account_id").notNull(),
    currencyCode: text("currency_code"),
    hasEcommerce: integer("has_ecommerce", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ga4_connections_project_idx").on(table.projectId),
    index("ga4_connections_organization_idx").on(table.organizationId),
  ],
);

const ga4Timestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
};

// One row per day per property. Holds every additive metric including daily
// trend-only distinct counts (total_users/active_users are stored for trends
// and NEVER summed — exact period values come from getPeriodUsers).
export const ga4DailySummary = sqliteTable(
  "ga4_daily_summary",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    ga4ConnectionId: text("ga4_connection_id").references(
      () => ga4Connections.id,
      { onDelete: "set null" },
    ),
    date: text("date").notNull(),
    sessions: integer("sessions").notNull().default(0),
    engagedSessions: integer("engaged_sessions").notNull().default(0),
    userEngagementDuration: real("user_engagement_duration")
      .notNull()
      .default(0),
    screenPageViews: integer("screen_page_views").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    newUsers: integer("new_users").notNull().default(0),
    totalUsers: integer("total_users").notNull().default(0),
    activeUsers: integer("active_users").notNull().default(0),
    totalRevenue: real("total_revenue").notNull().default(0),
    purchaseRevenue: real("purchase_revenue").notNull().default(0),
    transactions: integer("transactions").notNull().default(0),
    addToCarts: integer("add_to_carts").notNull().default(0),
    checkouts: integer("checkouts").notNull().default(0),
    ...ga4Timestamps,
  },
  (table) => [
    uniqueIndex("ga4_summary_upsert_idx").on(
      table.projectId,
      table.propertyId,
      table.date,
    ),
    index("ga4_summary_project_date_idx").on(table.projectId, table.date),
  ],
);

// Channel/source/medium rows. Canonical dimensions are non-null with the
// '(not set)' sentinel (identical NULL-behavior on D1/PG, no NULLS NOT
// DISTINCT); raw_* columns preserve the verbatim API strings for audit.
export const ga4DailyAcquisition = sqliteTable(
  "ga4_daily_acquisition",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    ga4ConnectionId: text("ga4_connection_id").references(
      () => ga4Connections.id,
      { onDelete: "set null" },
    ),
    date: text("date").notNull(),
    channelGroup: text("channel_group").notNull(),
    source: text("source").notNull(),
    medium: text("medium").notNull(),
    rawChannelGroup: text("raw_channel_group"),
    rawSource: text("raw_source"),
    rawMedium: text("raw_medium"),
    sessions: integer("sessions").notNull().default(0),
    engagedSessions: integer("engaged_sessions").notNull().default(0),
    userEngagementDuration: real("user_engagement_duration")
      .notNull()
      .default(0),
    screenPageViews: integer("screen_page_views").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    newUsers: integer("new_users").notNull().default(0),
    ...ga4Timestamps,
  },
  (table) => [
    uniqueIndex("ga4_acquisition_upsert_idx").on(
      table.projectId,
      table.propertyId,
      table.date,
      table.channelGroup,
      table.source,
      table.medium,
    ),
    index("ga4_acquisition_project_date_idx").on(table.projectId, table.date),
    index("ga4_acquisition_project_channel_date_idx").on(
      table.projectId,
      table.channelGroup,
      table.date,
    ),
  ],
);

// Normalized landing page per day, top-N bounded. landing_page is the shared
// normalized form; raw_landing_page keeps the verbatim API value.
export const ga4DailyLandingPages = sqliteTable(
  "ga4_daily_landing_pages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    ga4ConnectionId: text("ga4_connection_id").references(
      () => ga4Connections.id,
      { onDelete: "set null" },
    ),
    date: text("date").notNull(),
    landingPage: text("landing_page").notNull(),
    rawLandingPage: text("raw_landing_page"),
    sessions: integer("sessions").notNull().default(0),
    engagedSessions: integer("engaged_sessions").notNull().default(0),
    userEngagementDuration: real("user_engagement_duration")
      .notNull()
      .default(0),
    screenPageViews: integer("screen_page_views").notNull().default(0),
    ...ga4Timestamps,
  },
  (table) => [
    uniqueIndex("ga4_landing_upsert_idx").on(
      table.projectId,
      table.propertyId,
      table.date,
      table.landingPage,
    ),
    index("ga4_landing_project_page_date_idx").on(
      table.projectId,
      table.landingPage,
      table.date,
    ),
  ],
);

// Event per day with key-event flag (populated from the keyEvents metric).
export const ga4DailyEvents = sqliteTable(
  "ga4_daily_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    ga4ConnectionId: text("ga4_connection_id").references(
      () => ga4Connections.id,
      { onDelete: "set null" },
    ),
    date: text("date").notNull(),
    eventName: text("event_name").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    isKeyEvent: integer("is_key_event", { mode: "boolean" })
      .notNull()
      .default(false),
    ...ga4Timestamps,
  },
  (table) => [
    uniqueIndex("ga4_events_upsert_idx").on(
      table.projectId,
      table.propertyId,
      table.date,
      table.eventName,
    ),
    index("ga4_events_project_event_date_idx").on(
      table.projectId,
      table.eventName,
      table.date,
    ),
  ],
);

// Per-(date, grain) coverage units. Status machine:
// PENDING → SUCCESS_WITH_DATA | SUCCESS_ZERO_ROWS | FAILED.
// Every downstream consumer joins coverage and accepts only SUCCESS_*.
export const ga4SyncCoverage = sqliteTable(
  "ga4_sync_coverage",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    date: text("date").notNull(),
    grain: text("grain").notNull(),
    status: text("status").notNull().default("pending"),
    truncationMeta: text("truncation_meta"),
    ...ga4Timestamps,
  },
  (table) => [
    uniqueIndex("ga4_coverage_upsert_idx").on(
      table.projectId,
      table.propertyId,
      table.date,
      table.grain,
    ),
    index("ga4_coverage_project_grain_date_idx").on(
      table.projectId,
      table.grain,
      table.date,
    ),
  ],
);

// Sync run ledger. successful_units counts units finalized to SUCCESS_* in
// this run; §7 token selection reads the latest run with successful_units > 0.
export const ga4Syncs = sqliteTable(
  "ga4_syncs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ga4ConnectionId: text("ga4_connection_id").references(
      () => ga4Connections.id,
      { onDelete: "set null" },
    ),
    propertyId: text("property_id").notNull(),
    syncType: text("sync_type").notNull(),
    requestedStartDate: text("requested_start_date").notNull(),
    requestedEndDate: text("requested_end_date").notNull(),
    status: text("status").notNull().default("pending"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
    rowsFetched: integer("rows_fetched").notNull().default(0),
    rowsInserted: integer("rows_inserted").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    rowsFailed: integer("rows_failed").notNull().default(0),
    successfulUnits: integer("successful_units").notNull().default(0),
    error: text("error"),
    errorClass: text("error_class"),
    checkpoint: text("checkpoint"),
    ...ga4Timestamps,
  },
  (table) => [
    uniqueIndex("ga4_sync_one_active_per_property_idx")
      .on(table.projectId, table.propertyId)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index("ga4_sync_project_started_idx").on(table.projectId, table.startedAt),
  ],
);
