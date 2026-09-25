import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { user } from "./better-auth-schema";

// Postgres mirror of src/db/insights.schema.ts. Timestamps stay ISO-8601
// UTC text; the parity test enforces structural identity.
export const dashboardInsights = pgTable(
  "dashboard_insights",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    insightKey: text("insight_key").notNull(),
    composerKey: text("composer_key").notNull().default("dashboard"),
    type: text("type").notNull(),
    detectorKey: text("detector_key").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    explanationFact: text("explanation_fact").notNull(),
    recommendation: text("recommendation"),
    evidenceSummary: text("evidence_summary").notNull(),
    entityRefsJson: text("entity_refs_json").notNull().default("[]"),
    periodsFrom: text("periods_from"),
    periodsTo: text("periods_to"),
    sourcesJson: text("sources_json").notNull().default("[]"),
    findingKeysJson: text("finding_keys_json").notNull().default("[]"),
    opportunityIdsJson: text("opportunity_ids_json")
      .notNull()
      .default("[]"),
    metricsJson: text("metrics_json"),
    contentVersion: integer("content_version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    scanId: text("scan_id").notNull(),
    detectedAt: text("detected_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolveReason: text("resolve_reason"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("dashboard_insights_project_key_uidx").on(
      table.projectId,
      table.insightKey,
    ),
    index("dashboard_insights_project_resolved_idx").on(
      table.projectId,
      table.resolvedAt,
    ),
    index("dashboard_insights_project_severity_idx").on(
      table.projectId,
      table.severity,
    ),
    index("dashboard_insights_project_type_idx").on(
      table.projectId,
      table.type,
    ),
  ],
);

export const insightUserPreferences = pgTable(
  "insight_user_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    insightKey: text("insight_key").notNull(),
    dismissedContentVersion: integer("dismissed_content_version")
      .notNull()
      .default(0),
    snoozedUntil: text("snoozed_until"),
    hash: text("hash").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.projectId, table.insightKey],
      name: "insight_user_preferences_pkey",
    }),
    index("insight_user_preferences_project_key_idx").on(
      table.projectId,
      table.insightKey,
    ),
  ],
);
