import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { organization, user } from "./better-auth-schema";
import { reports } from "./reports.schema";

// Postgres mirror of src/db/report-sharing.schema.ts. Timestamps stay
// ISO-8601 UTC text; the parity test enforces structural identity.
export const reportShares = pgTable(
  "report_shares",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
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

export const reportEvents = pgTable(
  "report_events",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    organizationId: text("organization_id"),
    type: text("type").notNull(),
    userId: text("user_id"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("report_events_report_idx").on(table.reportId)],
);

export const organizationBranding = pgTable("organization_branding", {
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

export const projectClientProfiles = pgTable("project_client_profiles", {
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
