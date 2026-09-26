import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Scan ledger + stage machine (final-plan §§6/14). Mirrors
// src/db/intelligence.schema.ts; parity guarded by schema-parity.test.ts.
export const intelligenceRuns = pgTable(
  "intelligence_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    currentStage: text("current_stage").notNull().default("pending"),
    inputHash: text("input_hash"),
    inputSourceVersionsJson: text("input_source_versions_json"),
    detectorVersionsJson: text("detector_versions_json"),
    thresholdVersion: integer("threshold_version"),
    manifestKey: text("manifest_key"),
    manifestHash: text("manifest_hash"),
    findingsSchemaVersion: integer("findings_schema_version"),
    findingsCount: integer("findings_count").notNull().default(0),
    detectionAttemptMetaJson: text("detection_attempt_meta_json"),
    stageStateJson: text("stage_state_json"),
    error: text("error"),
    errorClass: text("error_class"),
    errorStage: text("error_stage"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    startedAt: text("started_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
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

export const intelligenceRunDetectors = pgTable(
  "intelligence_run_detectors",
  {
    runId: text("run_id")
      .notNull()
      .references(() => intelligenceRuns.id, { onDelete: "cascade" }),
    detectorKey: text("detector_key").notNull(),
    status: text("status").notNull().default("pending"),
    findingsCount: integer("findings_count").notNull().default(0),
    chunkKeysJson: text("chunk_keys_json"),
    skipReason: text("skip_reason"),
    error: text("error"),
    startedAt: text("started_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.detectorKey] }),
    index("intelligence_run_detectors_run_idx").on(table.runId),
  ],
);
