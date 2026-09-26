import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

// Autopilot durable runs (final-plan §§13/14). Logical runs own numbered
// attempts (one evidence universe each); steps are attempt-scoped with
// (attempt_id, seq) uniqueness so resume never re-collects completed
// evidence. Workflow definitions live in Task 16; this is the runtime.
export const autopilotRuns = sqliteTable(
  "autopilot_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    workflowType: text("workflow_type").notNull(),
    // pending|running|completed|failed|cancelled
    status: text("status").notNull().default("pending"),
    currentAttemptId: text("current_attempt_id"),
    // Binds the summary to the exact evidence state it was written from.
    evidenceHash: text("evidence_hash"),
    startedByUserId: text("started_by_user_id"),
    trigger: text("trigger").notNull().default("manual"),
    // Named failure/cancel reason (budget caps, source-changed exhaustion…).
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

export const autopilotRunAttempts = sqliteTable(
  "autopilot_run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => autopilotRuns.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    // Frozen source-state universe for this attempt (versions + set).
    sourceVersionsJson: text("source_versions_json").notNull(),
    sourceVersionsHash: text("source_versions_hash").notNull(),
    // pending|running|completed|failed|invalidated
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

export const autopilotSteps = sqliteTable(
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
    // collect|correlate|transform|synthesize|side_effect
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    // pending|running|completed|failed
    status: text("status").notNull().default("pending"),
    evidenceJson: text("evidence_json"),
    evidenceHash: text("evidence_hash"),
    effectiveSourceVersionsJson: text("effective_source_versions_json"),
    collectionAttempts: integer("collection_attempts").notNull().default(0),
    // Budget units consumed by this step (LLM tool calls); restored on resume.
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
