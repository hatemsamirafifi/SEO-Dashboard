import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ga4Connections } from "@/db/schema";

export type Ga4Connection = typeof ga4Connections.$inferSelect;

async function getByProjectId(projectId: string, organizationId: string) {
  const rows = await db
    .select()
    .from(ga4Connections)
    .where(
      and(
        eq(ga4Connections.projectId, projectId),
        eq(ga4Connections.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
async function upsert(input: {
  projectId: string;
  organizationId: string;
  propertyId: string;
  propertyDisplayName: string;
  connectedByUserId: string;
  ga4AccountId: string;
  currencyCode: string | null;
  hasEcommerce: boolean;
}) {
  const [row] = await db
    .insert(ga4Connections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: ga4Connections.projectId,
      where: eq(ga4Connections.organizationId, input.organizationId),
      set: {
        propertyId: input.propertyId,
        propertyDisplayName: input.propertyDisplayName,
        connectedByUserId: input.connectedByUserId,
        ga4AccountId: input.ga4AccountId,
        currencyCode: input.currencyCode,
        hasEcommerce: input.hasEcommerce,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert ga4_connection");
  return row;
}
async function deleteByProjectId(projectId: string, organizationId: string) {
  await db
    .delete(ga4Connections)
    .where(
      and(
        eq(ga4Connections.projectId, projectId),
        eq(ga4Connections.organizationId, organizationId),
      ),
    );
}
async function existsForConnectorAccount(userId: string, accountId: string) {
  const rows = await db
    .select({ id: ga4Connections.id })
    .from(ga4Connections)
    .where(
      and(
        eq(ga4Connections.connectedByUserId, userId),
        eq(ga4Connections.ga4AccountId, accountId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
export const Ga4ConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
  existsForConnectorAccount,
};
