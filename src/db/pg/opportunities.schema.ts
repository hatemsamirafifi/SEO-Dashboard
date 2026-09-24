import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Postgres mirror of src/db/opportunities.schema.ts. Timestamps stay
// ISO-8601 UTC text and booleans stay native boolean (see
// src/db/pg/app.schema.ts); the parity test enforces structural identity.
export const opportunities = pgTable(
  "opportunities",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    logicalKey: text("logical_key").notNull(),
    occurrenceNumber: integer("occurrence_number").notNull().default(1),
    type: text("type").notNull(),
    detectorKey: text("detector_key").notNull(),
    detectorVersion: integer("detector_version").notNull(),
    scoreVersion: integer("score_version").notNull(),
    status: text("status").notNull().default("open"),
    impactScore: integer("impact_score").notNull(),
    confidenceScore: integer("confidence_score").notNull(),
    priority: text("priority").notNull(),
    title: text("title").notNull(),
    explanationFact: text("explanation_fact").notNull(),
    recommendation: text("recommendation").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    keyword: text("keyword"),
    page: text("page"),
    sourceMetricsJson: text("source_metrics_json"),
    sourcesJson: text("sources_json").notNull().default("[]"),
    impactFactorsJson: text("impact_factors_json"),
    confidenceInputsJson: text("confidence_inputs_json"),
    lastSeenScanId: text("last_seen_scan_id"),
    consecutiveMisses: integer("consecutive_misses").notNull().default(0),
    stale: boolean("stale").notNull().default(false),
    staleAt: text("stale_at"),
    recurrenceOfId: text("recurrence_of_id"),
    supersededById: text("superseded_by_id"),
    firstDetectedAt: text("first_detected_at").notNull(),
    lastDetectedAt: text("last_detected_at").notNull(),
    completedAt: text("completed_at"),
    dismissedAt: text("dismissed_at"),
    dismissalReason: text("dismissal_reason"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("opportunities_active_key_uidx")
      .on(table.projectId, table.logicalKey)
      .where(sql`${table.status} IN ('open', 'in_progress')`),
    index("opportunities_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    index("opportunities_project_type_status_idx").on(
      table.projectId,
      table.type,
      table.status,
    ),
    index("opportunities_project_priority_impact_idx").on(
      table.projectId,
      table.priority,
      table.impactScore,
    ),
    index("opportunities_project_page_idx").on(table.projectId, table.page),
    index("opportunities_project_keyword_idx").on(
      table.projectId,
      table.keyword,
    ),
    index("opportunities_recurrence_of_idx").on(table.recurrenceOfId),
  ],
);

export const opportunityEvents = pgTable(
  "opportunity_events",
  {
    id: text("id").primaryKey(),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    eventKey: text("event_key").notNull(),
    scanId: text("scan_id"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("opportunity_events_occurrence_key_uidx").on(
      table.occurrenceId,
      table.eventKey,
    ),
    index("opportunity_events_occurrence_created_idx").on(
      table.occurrenceId,
      table.createdAt,
    ),
  ],
);
