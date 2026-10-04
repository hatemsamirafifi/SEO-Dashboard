import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

// Immutable report snapshots (final-plan §§12/14). Generation freezes metric
// aggregates + insight/opportunity copies into payloadSnapshotJson with a
// dual-sided provenance block; later data changes create new rows (never
// updates). Sharing/agency columns belong to Task 13 (additive migration).
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // overview|search_performance|rank_tracking|technical|executive — section
    // selectors over one payload shape (no per-type forks).
    type: text("type").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    // Frozen ReportPayload JSON (metrics + insight/opportunity copies).
    payloadSnapshotJson: text("payload_snapshot_json").notNull(),
    // consistent|concurrent_mutation — mirrors payload provenance.
    consistencyStatus: text("consistency_status").notNull(),
    intelligenceRunId: text("intelligence_run_id"),
    // Frozen agency+client combination (Task 13); null for pre-branding rows,
    // which render the default header. Never updated after insert.
    brandingSnapshotJson: text("branding_snapshot_json"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("reports_project_created_idx").on(table.projectId, table.createdAt),
    index("reports_project_type_idx").on(table.projectId, table.type),
  ],
);

// Scheduled email delivery (spec 012, D2b). Schedules reference report
// shares by id only — the raw share token is never stored here (P32/G7).
// Ownership is enforced at the service layer (same-project share required)
// to avoid a schema-module cycle with report-sharing.schema.ts; the share
// row itself cascades independently.
export const reportSchedules = sqliteTable(
  "report_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    reportType: text("report_type").notNull(),
    cadence: text("cadence").notNull(),
    recipients: text("recipients").notNull(),
    shareId: text("share_id"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    pausedAt: text("paused_at"),
    nextDueAt: text("next_due_at").notNull(),
    lastRunAt: text("last_run_at"),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("report_schedules_project_idx").on(table.projectId),
    index("report_schedules_due_idx").on(table.active, table.nextDueAt),
  ],
);

// The P33 idempotent run ledger: exactly one row per (schedule, due date),
// enforced by UNIQUE(schedule_id, scheduled_for) on both dialects.
export const reportScheduleRuns = sqliteTable(
  "report_schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => reportSchedules.id, { onDelete: "cascade" }),
    scheduledFor: text("scheduled_for").notNull(),
    reportId: text("report_id").references(() => reports.id, {
      onDelete: "cascade",
    }),
    state: text("state").notNull(),
    failureClass: text("failure_class"),
    skipReason: text("skip_reason"),
    recipientOutcomes: text("recipient_outcomes"),
    claimedAt: text("claimed_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("report_schedule_runs_unique_schedule_for_idx").on(
      table.scheduleId,
      table.scheduledFor,
    ),
    index("report_schedule_runs_schedule_idx").on(
      table.scheduleId,
      table.scheduledFor,
    ),
  ],
);
