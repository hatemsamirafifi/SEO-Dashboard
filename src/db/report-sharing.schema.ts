import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization, user } from "./better-auth-schema";
import { reports } from "./reports.schema";

// Report sharing + agency identity (final-plan §§12/14). Share tokens are
// hash-only at rest (raw 256-bit token shown once at creation); branding is
// split by scope (org agency vs per-project client) in dedicated tables —
// never `projects` columns. Scheduled/email delivery is deferred (§22): no
// schedules table exists (structural lock).

export const reportShares = sqliteTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // sha256 hex of the raw token; the raw value is never stored.
    tokenHash: text("token_hash").notNull().unique(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("report_shares_report_idx").on(table.reportId)],
);

// Audit trail for report lifecycle (created/shared/revoked/viewed;
// exported_pdf reserved for Task 14). Metadata carries ids only, never PII.
export const reportEvents = sqliteTable(
  "report_events",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    organizationId: text("organization_id"),
    // created|shared|revoked|viewed|exported_pdf
    type: text("type").notNull(),
    userId: text("user_id"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("report_events_report_idx").on(table.reportId)],
);

// Agency identity, one row per organization (org-upsert).
export const organizationBranding = sqliteTable("organization_branding", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  agencyName: text("agency_name").notNull().default(""),
  agencyLogoR2Key: text("agency_logo_r2_key"),
  accentColor: text("accent_color"),
  footerText: text("footer_text"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

// Client identity, one row per project. Notes stay internal: stored here,
// never frozen into snapshots or served publicly.
export const projectClientProfiles = sqliteTable("project_client_profiles", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull().default(""),
  clientLogoR2Key: text("client_logo_r2_key"),
  reportTitleOverride: text("report_title_override"),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});
