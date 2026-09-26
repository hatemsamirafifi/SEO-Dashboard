import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { GA4_OAUTH_PROVIDER_ID, GA4_OAUTH_SCOPES } from "@/shared/ga4";

async function listForUser(userId: string) {
  return db
    .select({ accountId: account.accountId, scope: account.scope })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GA4_OAUTH_PROVIDER_ID),
      ),
    );
}
async function deleteForUserAccount(userId: string, accountId: string) {
  await db
    .delete(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GA4_OAUTH_PROVIDER_ID),
        eq(account.accountId, accountId),
      ),
    );
}
function hasAnalyticsConsent(scope: string | null) {
  return Boolean(scope?.split(/[\s,]+/).includes(GA4_OAUTH_SCOPES[3]));
}
export const Ga4GrantRepository = {
  listForUser,
  deleteForUserAccount,
  hasAnalyticsConsent,
};
