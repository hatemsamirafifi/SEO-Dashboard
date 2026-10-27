import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Google Ads customer account connected to a project.
//
// OAuth tokens are NOT stored here: they live in the better-auth `account`
// table under providerId "google-ads". This row only records which Ads
// customer maps to which project, and which Google grant (`grantAccountId`)
// to use when calling the Ads API for that project.
export const googleAdsConnections = sqliteTable(
  "google_ads_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Ten-digit Google Ads customer ID, normalized (no dashes, no spaces).
    // The Ads API renders the int64 customer id as a bare digit string.
    customerId: text("customer_id").notNull(),
    // Ten-digit manager (MCC) id the customer is reached through, when the
    // grant belongs to a manager account rather than to the customer itself.
    loginCustomerId: text("login_customer_id"),
    // Human-readable customer name from the Ads API. Display only.
    customerDisplayName: text("customer_display_name"),
    // The Google OAuth `sub` of the granted account. This is NOT the Ads
    // customer id and NOT the better-auth `account` row id: it is the value
    // the OAuth grant is keyed by, so one grant can serve several projects.
    grantAccountId: text("grant_account_id").notNull(),
    // The OpenSEO user who performed the connection.
    connectedByUserId: text("connected_by_user_id").notNull(),
    currencyCode: text("currency_code"),
    timeZone: text("time_zone"),
    // True when the customer is flagged as a non-spendable test account.
    isTestAccount: integer("is_test_account", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // One selected Ads customer per project; switching customer replaces the
    // row instead of accumulating mappings.
    uniqueIndex("google_ads_connections_project_idx").on(table.projectId),
    index("google_ads_connections_organization_idx").on(table.organizationId),
    // Grant lookups ("is this grant already connected elsewhere?") filter by
    // user + grant across every project and organization, so index that pair.
    index("google_ads_connections_user_grant_idx").on(
      table.connectedByUserId,
      table.grantAccountId,
    ),
  ],
);
