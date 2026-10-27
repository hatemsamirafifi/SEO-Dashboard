import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Google Ads durable sync ledger (master plan phase 7).
//
// One run captures a deterministic, scoped identity: the reporting window
// (start/end, inclusive, account time zone), the trigger mode, the optional
// scheduled slot, and the connection fingerprint that authorized it
// (customer + login manager + grant account + the connection row's update
// instant). Competing triggers for the same identity coalesce through the
// unique active-claim index; stale runs are resumed only through the
// `attempt` fencing counter — every unit/finalization update is scoped by
// runId + attempt, never by runId alone.
//
// OAuth tokens never live here; the fingerprint stores the grant account id
// needed to validate that the run is still allowed to continue, and public
// result shapes must strip it.
const syncTimestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
};

export const googleAdsSyncRuns = sqliteTable(
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
    // Deterministic identity hash: window + mode + scheduled slot +
    // connection fingerprint. Two competing triggers hash to the same value.
    runKey: text("run_key").notNull(),
    // 'scheduled' | 'manual' | 'backfill' (bounded by the caller contract).
    mode: text("mode").notNull(),
    windowStartDate: text("window_start_date").notNull(),
    windowEndDate: text("window_end_date").notNull(),
    // scheduledFor instant when mode = 'scheduled', else null.
    scheduledSlot: text("scheduled_slot"),
    // Connection fingerprint components (NOT for public results).
    fingerprintGrantAccountId: text("fingerprint_grant_account_id").notNull(),
    // Immutable id of the google_ads_connections row at trigger time; a
    // deleted and re-created connection never resurrects an old claim.
    fingerprintConnectionId: text("fingerprint_connection_id").notNull(),
    fingerprintLoginCustomerId: text("fingerprint_login_customer_id"),
    fingerprintConnectionUpdatedAt: text(
      "fingerprint_connection_updated_at",
    ).notNull(),
    // Fencing counter. Re-claiming a stale run bumps it; stale workers' unit
    // writes stop matching it and become no-ops.
    attempt: integer("attempt").notNull().default(1),
    // 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'fenced'.
    status: text("status").notNull().default("running"),
    // Lease management for recovery: active runs whose lease has expired may
    // be re-claimed (attempt bump) or swept failed.
    leaseExpiresAt: text("lease_expires_at").notNull(),
    heartbeatAt: text("heartbeat_at"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
    unitsTotal: integer("units_total").notNull().default(0),
    unitsSucceeded: integer("units_succeeded").notNull().default(0),
    unitsFailed: integer("units_failed").notNull().default(0),
    // Bounded error class only; never upstream response bodies.
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    ...syncTimestamps,
  },
  (table) => [
    // Coalescing: a unique ACTIVE claim per (project, customer, identity).
    // Finalized runs release the key, so a later identical trigger creates a
    // fresh run.
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

// Normalized per-day/grain units of work inside a sync run. Statuses:
// pending -> success_with_data | success_zero_rows | partial | failed.
// The storage publish protocol is what turns a fetch into
// success_with_data/success_zero_rows; 'partial' marks a fetch the worker
// knows was incomplete (never treated as complete coverage downstream).
// Replaying a run skips committed success_* units; retrying a failed unit
// must never duplicate facts (the analytics publish protocol guarantees
// that by generation replacement).
export const googleAdsSyncUnits = sqliteTable(
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
    // Attempt of the claim that last wrote this unit (fencing evidence).
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
