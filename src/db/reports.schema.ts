import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

// Immutable report snapshots (final-plan §§12/14). Generation freezes metric
// aggregates + insight/opportunity copies into payloadSnapshotJson with a
// dual-sided provenance block; later data changes create new rows (never
// updates). Sharing/agency columns belong to Task 13 (additive migration).
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // overview|search_performance|rank_tracking|technical|executive — section
    // selectors over one payload shape (no per-type forks).
    type: text("type").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    // Frozen ReportPayload JSON (metrics + insight/opportunity copies).
    payloadSnapshotJson: text("payload_snapshot_json").notNull(),
    // consistent|concurrent_mutation — mirrors payload provenance.
    consistencyStatus: text("consistency_status").notNull(),
    intelligenceRunId: text("intelligence_run_id"),
    // Frozen agency+client combination (Task 13); null for pre-branding rows,
    // which render the default header. Never updated after insert.
    brandingSnapshotJson: text("branding_snapshot_json"),
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
