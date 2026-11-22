import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { user, organization } from "./better-auth-schema";
import { projects } from "./app.schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const seoActionPlans = pgTable(
  "seo_action_plans",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("seo_action_plans_project_idx").on(table.projectId),
    index("seo_action_plans_org_idx").on(table.organizationId),
  ],
);

export const seoActionItems = pgTable(
  "seo_action_items",
  {
    id: text("id").primaryKey(),
    actionPlanId: text("action_plan_id")
      .notNull()
      .references(() => seoActionPlans.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    recommendationFingerprint: text("recommendation_fingerprint").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").notNull(),
    priority: text("priority").notNull(),
    effort: text("effort"),
    expectedImpact: text("expected_impact"),
    evidenceConfidence: text("evidence_confidence"),
    targetKeyword: text("target_keyword"),
    targetUrl: text("target_url"),
    recommendedAction: text("recommended_action"),
    validationMetric: text("validation_metric"),
    baselineValue: text("baseline_value"),
    baselineObservationDate: text("baseline_observation_date"),
    dueDate: text("due_date"),
    status: text("status").notNull().default("proposed"),
    verificationOutcome: text("verification_outcome"),
    verificationNotes: text("verification_notes"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
    verifiedAt: text("verified_at"),
  },
  (table) => [
    index("seo_action_items_plan_idx").on(table.actionPlanId),
    index("seo_action_items_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    uniqueIndex("seo_action_items_fingerprint_idx").on(
      table.projectId,
      table.recommendationFingerprint,
    ),
  ],
);

export const seoActionEvidence = pgTable(
  "seo_action_evidence",
  {
    id: text("id").primaryKey(),
    actionItemId: text("action_item_id")
      .notNull()
      .references(() => seoActionItems.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    provider: text("provider").notNull(),
    sourceRecordId: text("source_record_id"),
    metricName: text("metric_name").notNull(),
    metricValue: text("metric_value").notNull(),
    observationDate: text("observation_date"),
    observationRange: text("observation_range"),
    targetDevice: text("target_device"),
    targetCountry: text("target_country"),
    targetUrl: text("target_url"),
    metadata: text("metadata"),
  },
  (table) => [index("seo_action_evidence_item_idx").on(table.actionItemId)],
);

export const seoActionEvents = pgTable(
  "seo_action_events",
  {
    id: text("id").primaryKey(),
    actionItemId: text("action_item_id")
      .notNull()
      .references(() => seoActionItems.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    previousStatus: text("previous_status"),
    newStatus: text("new_status").notNull(),
    notes: text("notes"),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [index("seo_action_events_item_idx").on(table.actionItemId)],
);
