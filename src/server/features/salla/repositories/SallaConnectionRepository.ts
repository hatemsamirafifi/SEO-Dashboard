import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { sallaConnections } from "@/db/schema";
import type { SallaStoreIdentity } from "../sallaOAuth";
import {
  decryptSallaTokenEnvelope,
  type SallaTokenEnvelope,
} from "../sallaTokens";

export type SallaConnection = typeof sallaConnections.$inferSelect;

// Public view of a grant: everything except the sealed token ciphertext.
export type SallaConnectionView = Omit<SallaConnection, "tokenCiphertext">;

function toView(row: SallaConnection): SallaConnectionView {
  const { tokenCiphertext: _sealed, ...view } = row;
  return view;
}

async function getByProjectId(
  projectId: string,
): Promise<SallaConnectionView | null> {
  const rows = await db
    .select()
    .from(sallaConnections)
    .where(eq(sallaConnections.projectId, projectId))
    .limit(1);
  return rows[0] ? toView(rows[0]) : null;
}

/**
 * The ONLY way to read sealed tokens: scoped to the owning project. Refresh
 * decrypts, rotates, re-encrypts in place — the plaintext never leaves the
 * server module and is never logged.
 */
export async function getTokenEnvelope(
  projectId: string,
): Promise<{ envelope: SallaTokenEnvelope; connectedByUserId: string } | null> {
  const rows = await db
    .select({
      tokenCiphertext: sallaConnections.tokenCiphertext,
      connectedByUserId: sallaConnections.connectedByUserId,
      tokenExpiresAt: sallaConnections.tokenExpiresAt,
    })
    .from(sallaConnections)
    .where(eq(sallaConnections.projectId, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const envelope = await decryptSallaTokenEnvelope(row.tokenCiphertext);
  if (!envelope) return null;
  return { envelope, connectedByUserId: row.connectedByUserId };
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  connectedByUserId: string;
  identity: SallaStoreIdentity;
  tokenCiphertext: string;
  tokenExpiresAt: string;
  scope: string;
}): Promise<SallaConnectionView> {
  const [row] = await db
    .insert(sallaConnections)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      organizationId: input.organizationId,
      connectedByUserId: input.connectedByUserId,
      merchantId: input.identity.merchantId,
      merchantName: input.identity.merchantName,
      storeId: input.identity.storeId,
      storeDomain: input.identity.storeDomain,
      storeUrl: input.identity.storeUrl,
      storeStatus: input.identity.storeStatus,
      scope: input.scope,
      tokenCiphertext: input.tokenCiphertext,
      tokenExpiresAt: input.tokenExpiresAt,
      connectedAt: sql`(current_timestamp)`,
    })
    .onConflictDoUpdate({
      target: sallaConnections.projectId,
      set: {
        organizationId: input.organizationId,
        connectedByUserId: input.connectedByUserId,
        merchantId: input.identity.merchantId,
        merchantName: input.identity.merchantName,
        storeId: input.identity.storeId,
        storeDomain: input.identity.storeDomain,
        storeUrl: input.identity.storeUrl,
        storeStatus: input.identity.storeStatus,
        scope: input.scope,
        // Reauthorization replaces the sealed pair wholesale.
        tokenCiphertext: input.tokenCiphertext,
        tokenExpiresAt: input.tokenExpiresAt,
        connectedAt: sql`(current_timestamp)`,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to upsert salla_connections");
  }
  return toView(row);
}

async function updateTokenEnvelope(input: {
  projectId: string;
  tokenCiphertext: string;
  tokenExpiresAt: string;
}): Promise<void> {
  await db
    .update(sallaConnections)
    .set({
      tokenCiphertext: input.tokenCiphertext,
      tokenExpiresAt: input.tokenExpiresAt,
      updatedAt: sql`(current_timestamp)`,
    })
    .where(eq(sallaConnections.projectId, input.projectId));
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(sallaConnections)
    .where(eq(sallaConnections.projectId, projectId));
}

async function existsForStore(
  userId: string,
  merchantId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: sallaConnections.id })
    .from(sallaConnections)
    .where(
      and(
        eq(sallaConnections.connectedByUserId, userId),
        eq(sallaConnections.merchantId, merchantId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export const SallaConnectionRepository = {
  getByProjectId,
  getTokenEnvelope,
  upsert,
  updateTokenEnvelope,
  deleteByProjectId,
  existsForStore,
};
