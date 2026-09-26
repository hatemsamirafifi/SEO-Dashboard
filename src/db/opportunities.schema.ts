import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

// Opportunity occurrences + event ledger (final-plan §§10/14). Findings are
// transient (R2 artifact); opportunities persist with lifecycle: one ACTIVE
// row per logicalKey (partial unique), recurrence chains after terminal
// states, supersession chains across detector versions. Impact and
// confidence stay separate columns — no combined-score key exists.
export const opportunities = sqliteTable(
  "opportunities",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // detectorKey:entityKey — stable across scans (no period).
    logicalKey: text("logical_key").notNull(),
    occurrenceNumber: integer("occurrence_number").notNull().default(1),
    // Detector-family type (traffic|ctr|decay|ranking|cannibalization|
    // technical|backlinks); free string, indexed for Task 9 filters.
    type: text("type").notNull(),
    detectorKey: text("detector_key").notNull(),
    detectorVersion: integer("detector_version").notNull(),
    scoreVersion: integer("score_version").notNull(),
    // open|in_progress|completed|dismissed
    status: text("status").notNull().default("open"),
    impactScore: integer("impact_score").notNull(),
    confidenceScore: integer("confidence_score").notNull(),
    // Derived Critical|High|Medium|Low via the shared priority matrix.
    priority: text("priority").notNull(),
    title: text("title").notNull(),
    explanationFact: text("explanation_fact").notNull(),
    // Recommendations come exclusively from materializer templates —
    // detectors can never write this column.
    recommendation: text("recommendation").notNull(),
    // Frozen finding evidence JSON + sourceRefs (reproducibility).
    evidenceJson: text("evidence_json").notNull(),
    keyword: text("keyword"),
    page: text("page"),
    sourceMetricsJson: text("source_metrics_json"),
    sourcesJson: text("sources_json").notNull().default("[]"),
    // Renormalized impact inputs ("why" sums to score, §19).
    impactFactorsJson: text("impact_factors_json"),
    // Decay 8-input function and friends (Task 9 "why" panel).
    confidenceInputsJson: text("confidence_inputs_json"),
    lastSeenScanId: text("last_seen_scan_id"),
    consecutiveMisses: integer("consecutive_misses").notNull().default(0),
    stale: integer("stale", { mode: "boolean" }).notNull().default(false),
    staleAt: text("stale_at"),
    recurrenceOfId: text("recurrence_of_id"),
    supersededById: text("superseded_by_id"),
    firstDetectedAt: text("first_detected_at").notNull(),
    lastDetectedAt: text("last_detected_at").notNull(),
    completedAt: text("completed_at"),
    dismissedAt: text("dismissed_at"),
    // Dismissal requires a reason (plan §10 lifecycle).
    dismissalReason: text("dismissal_reason"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // One active occurrence per key; history coexists after terminal states.
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

// Append-only audit trail with idempotency keys: same
// (occurrence, event_key) twice (resume/retry) records once.
export const opportunityEvents = sqliteTable(
  "opportunity_events",
  {
    id: text("id").primaryKey(),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    // detected|redetected|rescored|evidence_updated|status_changed|
    // stale_marked|stale_cleared|completed|dismissed|recurred|superseded
    type: text("type").notNull(),
    // stableHash(occurrence|type|scanOrAttempt|contentHash)
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
