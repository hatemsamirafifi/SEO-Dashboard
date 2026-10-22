import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Owner-authorized Salla store grant per project — mirrors salla.schema.ts.
export const sallaConnections = pgTable(
  "salla_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectedByUserId: text("connected_by_user_id").notNull(),
    merchantId: text("merchant_id").notNull(),
    merchantName: text("merchant_name"),
    storeId: text("store_id").notNull(),
    storeDomain: text("store_domain"),
    storeUrl: text("store_url"),
    storeStatus: text("store_status"),
    scope: text("scope"),
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenExpiresAt: text("token_expires_at"),
    connectedAt: text("connected_at").notNull().default(isoNow),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("salla_connections_project_idx").on(table.projectId),
    index("salla_connections_organization_idx").on(table.organizationId),
  ],
);
