import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Connected Google Search Console property per project.
// OAuth tokens live in the better-auth `account` table under providerId
// "google-search-console"; this row only records which verified property maps
// to a project and whose grant to use when calling the GSC API.
export const gscConnections = pgTable(
  "gsc_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Stored verbatim from sites.list — "sc-domain:example.com" or
    // "https://example.com/". Never normalize; GSC matches it byte-for-byte.
    siteUrl: text("site_url").notNull(),
    // Whose google-search-console grant getAccessToken should use.
    connectedByUserId: text("connected_by_user_id").notNull(),
    gscAccountId: text("gsc_account_id"),
    connectedAccountEmail: text("connected_account_email"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    // One selected property per project in v1; switching replaces the row.
    uniqueIndex("gsc_connections_project_idx").on(table.projectId),
    index("gsc_connections_organization_idx").on(table.organizationId),
  ],
);

export const gscSearchPerformance = pgTable(
  "gsc_search_performance",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    gscConnectionId: text("gsc_connection_id").references(
      () => gscConnections.id,
      { onDelete: "set null" },
    ),
    property: text("property").notNull(),
    date: text("date").notNull(),
    grain: text("grain").notNull(),
    grainKey: text("grain_key").notNull(),
    query: text("query"),
    page: text("page"),
    country: text("country"),
    device: text("device"),
    searchAppearance: text("search_appearance"),
    searchType: text("search_type").notNull().default("web"),
    clicks: integer("clicks").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    ctr: real("ctr").notNull().default(0),
    position: real("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("gsc_search_perf_upsert_idx").on(
      table.projectId,
      table.property,
      table.searchType,
      table.date,
      table.grain,
      table.grainKey,
    ),
    index("gsc_search_perf_project_date_idx").on(
      table.projectId,
      table.date,
    ),
    index("gsc_search_perf_project_property_date_idx").on(
      table.projectId,
      table.property,
      table.date,
    ),
    index("gsc_search_perf_project_query_date_idx").on(
      table.projectId,
      table.query,
      table.date,
    ),
    index("gsc_search_perf_project_page_date_idx").on(
      table.projectId,
      table.page,
      table.date,
    ),
    index("gsc_search_perf_project_country_date_idx").on(
      table.projectId,
      table.country,
      table.date,
    ),
    index("gsc_search_perf_project_device_date_idx").on(
      table.projectId,
      table.device,
      table.date,
    ),
    index("gsc_search_perf_project_grain_date_idx").on(
      table.projectId,
      table.grain,
      table.date,
    ),
  ],
);

export const gscSearchPerformanceSyncs = pgTable(
  "gsc_search_performance_syncs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    gscConnectionId: text("gsc_connection_id").references(
      () => gscConnections.id,
      { onDelete: "set null" },
    ),
    property: text("property").notNull(),
    syncType: text("sync_type").notNull(),
    requestedStartDate: text("requested_start_date").notNull(),
    requestedEndDate: text("requested_end_date").notNull(),
    actualLastSuccessfulDate: text("actual_last_successful_date"),
    status: text("status").notNull().default("pending"),
    startedAt: text("started_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
    rowsFetched: integer("rows_fetched").notNull().default(0),
    rowsInserted: integer("rows_inserted").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    rowsFailed: integer("rows_failed").notNull().default(0),
    error: text("error"),
    checkpoint: text("checkpoint"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("gsc_sync_one_active_per_project_idx")
      .on(table.projectId, table.property)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index("gsc_sync_project_status_idx").on(
      table.projectId,
      table.status,
      table.startedAt,
    ),
  ],
);
