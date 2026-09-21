import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Scan ledger + stage machine (final-plan §§6/14). One row per intelligence
// scan; stage boundaries are the transaction boundaries and each stage's
// writes are idempotent. Findings themselves are NEVER stored here — they
// freeze into the R2 artifact (§6) and the run row only holds pointers.
export const intelligenceRuns = sqliteTable(
  "intelligence_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // pending|detecting|materializing|composing|completed|partial|failed
    status: text("status").notNull().default("pending"),
    // pending|detecting|materializing|composing (resume pointer)
    currentStage: text("current_stage").notNull().default("pending"),
    inputHash: text("input_hash"),
    inputSourceVersionsJson: text("input_source_versions_json"),
    detectorVersionsJson: text("detector_versions_json"),
    thresholdVersion: integer("threshold_version"),
    manifestKey: text("manifest_key"),
    // Full 64-hex digest, never a truncated prefix.
    manifestHash: text("manifest_hash"),
    findingsSchemaVersion: integer("findings_schema_version"),
    findingsCount: integer("findings_count").notNull().default(0),
    detectionAttemptMetaJson: text("detection_attempt_meta_json"),
    stageStateJson: text("stage_state_json"),
    error: text("error"),
    errorClass: text("error_class"),
    errorStage: text("error_stage"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("intelligence_runs_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
    index("intelligence_runs_project_status_idx").on(
      table.projectId,
      table.status,
    ),
  ],
);

// Per-detector outcome within a run: completed counts + chunk keys, skipped
// with reason, or failed with error. PK(run_id, detector_key).
export const intelligenceRunDetectors = sqliteTable(
  "intelligence_run_detectors",
  {
    runId: text("run_id")
      .notNull()
      .references(() => intelligenceRuns.id, { onDelete: "cascade" }),
    detectorKey: text("detector_key").notNull(),
    // completed|skipped|failed
    status: text("status").notNull().default("pending"),
    findingsCount: integer("findings_count").notNull().default(0),
    chunkKeysJson: text("chunk_keys_json"),
    skipReason: text("skip_reason"),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.detectorKey] }),
    index("intelligence_run_detectors_run_idx").on(table.runId),
  ],
);
