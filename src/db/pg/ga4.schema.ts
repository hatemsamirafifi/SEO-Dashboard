import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

export const ga4Connections = pgTable(
  "ga4_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    propertyDisplayName: text("property_display_name").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    ga4AccountId: text("ga4_account_id").notNull(),
    currencyCode: text("currency_code"),
    hasEcommerce: boolean("has_ecommerce").notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`now()`),
    updatedAt: text("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("ga4_connections_project_idx").on(table.projectId),
    index("ga4_connections_organization_idx").on(table.organizationId),
  ],
);
