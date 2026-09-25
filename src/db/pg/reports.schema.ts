import { sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("reports_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("reports_project_type_idx").on(table.projectId, table.type),
  ],
);
