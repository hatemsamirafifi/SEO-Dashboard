import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections, projects } from "@/db/schema";
import { normalizeGoogleAdsCustomerId } from "@/shared/google-ads";

export type GoogleAdsConnection = typeof googleAdsConnections.$inferSelect;

/** Everything a caller supplies to map an Ads customer to a project. The row
 *  id and the timestamps are generated server side. */
export type GoogleAdsConnectionInput = {
  projectId: string;
  organizationId: string;
  customerId: string;
  loginCustomerId: string | null;
  customerDisplayName: string | null;
  /** The Google OAuth `sub` of the granted account — never an Ads customer id
   *  and never a better-auth `account` row id. */
  grantAccountId: string;
  connectedByUserId: string;
  currencyCode: string | null;
  timeZone: string | null;
  isTestAccount: boolean;
};

function normalizeCustomerId(value: string): string {
  const normalized = normalizeGoogleAdsCustomerId(value);
  if (!normalized) throw new Error("Invalid Google Ads customer id");
  return normalized;
}

async function getByProjectId(
  projectId: string,
  organizationId: string,
): Promise<GoogleAdsConnection | null> {
  const rows = await db
    .select()
    .from(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.projectId, projectId),
        eq(googleAdsConnections.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(
  input: GoogleAdsConnectionInput,
): Promise<GoogleAdsConnection> {
  const customerId = normalizeCustomerId(input.customerId);
  const loginCustomerId =
    input.loginCustomerId === null
      ? null
      : normalizeCustomerId(input.loginCustomerId);
  const grantAccountId = input.grantAccountId.trim();
  if (!grantAccountId)
    throw new Error("Google Ads grant account id is required");

  // The project must belong to the organization that claims the mapping.
  // Verified before the write instead of only through the conflict guard, so
  // a foreign organization can neither create nor steal the mapping.
  const projectRows = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw new Error("Google Ads connection project does not exist");
  if (project.organizationId !== input.organizationId) {
    throw new Error(
      "Google Ads connection project does not belong to the organization",
    );
  }

  const [row] = await db
    .insert(googleAdsConnections)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      organizationId: input.organizationId,
      customerId,
      loginCustomerId,
      customerDisplayName: input.customerDisplayName,
      grantAccountId,
      connectedByUserId: input.connectedByUserId,
      currencyCode: input.currencyCode,
      timeZone: input.timeZone,
      isTestAccount: input.isTestAccount,
    })
    .onConflictDoUpdate({
      target: googleAdsConnections.projectId,
      // Second guard: an existing row owned by another organization is never
      // rewritten. The conflict then updates nothing and returns no row.
      setWhere: eq(googleAdsConnections.organizationId, input.organizationId),
      set: {
        customerId,
        loginCustomerId,
        customerDisplayName: input.customerDisplayName,
        grantAccountId,
        connectedByUserId: input.connectedByUserId,
        currencyCode: input.currencyCode,
        timeZone: input.timeZone,
        isTestAccount: input.isTestAccount,
        // created_at is deliberately absent: the original row keeps it.
        updatedAt: new Date().toISOString(),
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert google_ads_connection");
  return row;
}

async function deleteByProjectId(
  projectId: string,
  organizationId: string,
): Promise<void> {
  await db
    .delete(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.projectId, projectId),
        eq(googleAdsConnections.organizationId, organizationId),
      ),
    );
}

/** True when the connecting user already used this Google grant somewhere.
 *  Scans every project and organization on purpose: the answer is a
 *  cross-project reference check, so no row data is returned. */
async function existsForConnectorAccount(
  userId: string,
  grantAccountId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: googleAdsConnections.id })
    .from(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.connectedByUserId, userId),
        eq(googleAdsConnections.grantAccountId, grantAccountId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export const GoogleAdsConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
  existsForConnectorAccount,
};
