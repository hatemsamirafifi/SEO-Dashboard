import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { createGa4Client, type Ga4Property } from "@/server/lib/ga4Client";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import {
  Ga4ConnectionRepository,
  type Ga4Connection,
} from "../repositories/Ga4ConnectionRepository";

type GrantProperties = { accountId: string; properties: Ga4Property[] };

async function grants(userId: string) {
  return db
    .select({ accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GA4_OAUTH_PROVIDER_ID),
      ),
    );
}
async function userHasGrant(userId: string) {
  return (await grants(userId)).length > 0;
}
async function getConnection(
  projectId: string,
  organizationId: string,
): Promise<Ga4Connection | null> {
  return Ga4ConnectionRepository.getByProjectId(projectId, organizationId);
}
async function listPropertiesForUser(
  userId: string,
): Promise<GrantProperties[]> {
  const userGrants = await grants(userId);
  return Promise.all(
    userGrants.map(async ({ accountId }) => ({
      accountId,
      properties: await createGa4Client({
        userId,
        ga4AccountId: accountId,
      }).listProperties(),
    })),
  );
}
async function setProperty(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  accountId: string;
  propertyId: string;
}) {
  const userGrants = await grants(input.userId);
  if (!userGrants.some((grant) => grant.accountId === input.accountId))
    throw new AppError(
      "NOT_FOUND",
      "That Google Analytics account isn't connected to your OpenSEO account.",
    );
  const properties = await createGa4Client({
    userId: input.userId,
    ga4AccountId: input.accountId,
  }).listProperties();
  const property = properties.find(
    (entry) => entry.propertyId === input.propertyId,
  );
  if (!property)
    throw new AppError(
      "NOT_FOUND",
      "That Google Analytics property isn't available on your connected Google account.",
    );
  return Ga4ConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    connectedByUserId: input.userId,
    ga4AccountId: input.accountId,
    propertyId: property.propertyId,
    propertyDisplayName: property.displayName,
    currencyCode: property.currencyCode,
    hasEcommerce: false,
  });
}
async function disconnect(input: {
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  const connection = await getConnection(input.projectId, input.organizationId);
  await Ga4ConnectionRepository.deleteByProjectId(
    input.projectId,
    input.organizationId,
  );
  if (connection?.connectedByUserId !== input.userId) return;
  if (
    !(await Ga4ConnectionRepository.existsForConnectorAccount(
      input.userId,
      connection.ga4AccountId,
    ))
  ) {
    await db
      .delete(account)
      .where(
        and(
          eq(account.userId, input.userId),
          eq(account.providerId, GA4_OAUTH_PROVIDER_ID),
          eq(account.accountId, connection.ga4AccountId),
        ),
      );
  }
}
export const Ga4Service = {
  userHasGrant,
  getConnection,
  listPropertiesForUser,
  setProperty,
  disconnect,
};
