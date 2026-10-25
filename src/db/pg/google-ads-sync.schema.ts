import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Postgres mirror of src/db/google-ads-sync.schema.ts. The two files MUST
// stay structurally interchangeable: schema-parity.test.ts fails loudly when
// they drift. See the Google Ads storage notes there.

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const syncTimestamps = {
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
};

export const googleAdsSyncRuns = pgTable(
  "google_ads_sync_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    runKey: text("run_key").notNull(),
    mode: text("mode").notNull(),
    windowStartDate: text("window_start_date").notNull(),
    windowEndDate: text("window_end_date").notNull(),
    scheduledSlot: text("scheduled_slot"),
    fingerprintGrantAccountId: text("fingerprint_grant_account_id").notNull(),
    // Immutable id of the google_ads_connections row at trigger time; a
    // deleted and re-created connection never resurrects an old claim.
    fingerprintConnectionId: text("fingerprint_connection_id").notNull(),
    fingerprintLoginCustomerId: text("fingerprint_login_customer_id"),
    fingerprintConnectionUpdatedAt: text(
      "fingerprint_connection_updated_at",
    ).notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull().default("running"),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    heartbeatAt: text("heartbeat_at"),
    startedAt: text("started_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
    unitsTotal: integer("units_total").notNull().default(0),
    unitsSucceeded: integer("units_succeeded").notNull().default(0),
    unitsFailed: integer("units_failed").notNull().default(0),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    ...syncTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_sync_runs_active_claim_idx")
      .on(table.projectId, table.customerId, table.runKey)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index("google_ads_sync_runs_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("google_ads_sync_runs_scope_status_idx").on(
      table.projectId,
      table.customerId,
      table.status,
    ),
  ],
);

export const googleAdsSyncUnits = pgTable(
  "google_ads_sync_units",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => googleAdsSyncRuns.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    date: text("date").notNull(),
    grain: text("grain").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    ...syncTimestamps,
  },
  (table) => [
    uniqueIndex("google_ads_sync_units_unique_idx").on(
      table.runId,
      table.date,
      table.grain,
    ),
    index("google_ads_sync_units_replay_idx").on(
      table.projectId,
      table.customerId,
      table.grain,
      table.status,
    ),
    index("google_ads_sync_units_run_status_idx").on(table.runId, table.status),
  ],
);
