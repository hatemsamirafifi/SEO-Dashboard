import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Postgres mirror of src/db/autopilot.schema.ts. Timestamps stay ISO-8601
// UTC text; the parity test enforces structural identity.
export const autopilotRuns = pgTable(
  "autopilot_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    workflowType: text("workflow_type").notNull(),
    status: text("status").notNull().default("pending"),
    currentAttemptId: text("current_attempt_id"),
    evidenceHash: text("evidence_hash"),
    startedByUserId: text("started_by_user_id"),
    trigger: text("trigger").notNull().default("manual"),
    error: text("error"),
    errorClass: text("error_class"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("autopilot_runs_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    index("autopilot_runs_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
  ],
);

export const autopilotRunAttempts = pgTable(
  "autopilot_run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => autopilotRuns.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    sourceVersionsJson: text("source_versions_json").notNull(),
    sourceVersionsHash: text("source_versions_hash").notNull(),
    status: text("status").notNull().default("pending"),
    invalidationReason: text("invalidation_reason"),
    supersededByAttemptId: text("superseded_by_attempt_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("autopilot_attempts_run_number_uidx").on(
      table.runId,
      table.attemptNumber,
    ),
    index("autopilot_attempts_run_idx").on(table.runId),
  ],
);

export const autopilotSteps = pgTable(
  "autopilot_steps",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => autopilotRunAttempts.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => autopilotRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"),
    evidenceJson: text("evidence_json"),
    evidenceHash: text("evidence_hash"),
    effectiveSourceVersionsJson: text("effective_source_versions_json"),
    collectionAttempts: integer("collection_attempts").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    reusedFromAttempt: text("reused_from_attempt"),
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("autopilot_steps_attempt_seq_uidx").on(
      table.attemptId,
      table.seq,
    ),
    index("autopilot_steps_run_idx").on(table.runId),
  ],
);
