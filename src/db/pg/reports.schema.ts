import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Postgres mirror of src/db/reports.schema.ts. Timestamps stay ISO-8601
// UTC text; the parity test enforces structural identity.
export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    type: text("type").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    payloadSnapshotJson: text("payload_snapshot_json").notNull(),
    consistencyStatus: text("consistency_status").notNull(),
    intelligenceRunId: text("intelligence_run_id"),
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

// Postgres mirror of the spec 012 tables above. Timestamps stay ISO-8601 UTC
// text; booleans are native boolean (house convention); the parity test
// enforces structural identity with the D1 definitions.
export const reportSchedules = pgTable(
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
    active: boolean("active").notNull().default(true),
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

export const reportScheduleRuns = pgTable(
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
