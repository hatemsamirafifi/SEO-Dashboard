import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// Owner-authorized Salla store grant per project (Phase 1.5: mock-tested only,
// feature-flagged off until valid app credentials exist).
//
// Tokens never live in the better-auth `account` table: Salla grants are not
// Google accounts, and the access/refresh pair is sealed with a dedicated
// deployment secret (SALLA_TOKEN_ENCRYPTION_KEY) — never BETTER_AUTH_SECRET —
// so Salla ciphertext cannot be cross-decrypted by any other credential scope.
export const sallaConnections = sqliteTable(
  "salla_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The user that completed the owner authorization; refresh always runs
    // under this user's grant, not any follower's.
    connectedByUserId: text("connected_by_user_id").notNull(),
    // Verified at authorize time from /oauth2/user/info — stores are owned by
    // merchants; the row records exactly which store granted access.
    merchantId: text("merchant_id").notNull(),
    merchantName: text("merchant_name"),
    storeId: text("store_id").notNull(),
    storeDomain: text("store_domain"),
    storeUrl: text("store_url"),
    storeStatus: text("store_status"),
    scope: text("scope"),
    // Encrypted token envelope JSON (sallaTokens.ts). Never selected for API
    // responses; refresh decrypts, rotates, re-encrypts in place.
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenExpiresAt: text("token_expires_at"),
    connectedAt: text("connected_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // One Salla grant per project; reconnecting replaces the row.
    uniqueIndex("salla_connections_project_idx").on(table.projectId),
    index("salla_connections_organization_idx").on(table.organizationId),
  ],
);
