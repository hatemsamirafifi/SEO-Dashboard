import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { GOOGLE_ADS_OAUTH_PROVIDER_ID } from "@/shared/google-ads";

/** The only scope a usable Google Ads grant can carry: Google exposes no
 *  read-only Ads scope, so the grant is either full-access or absent. */
export const GOOGLE_ADS_ADWORDS_SCOPE =
  "https://www.googleapis.com/auth/adwords";

/** The only fields a grant reader may expose. Tokens stay in better-auth
 *  storage and are never read out of it here. */
export type GoogleAdsGrant = {
  accountId: string;
  scope: string | null;
};

async function listForUser(userId: string): Promise<GoogleAdsGrant[]> {
  return db
    .select({ accountId: account.accountId, scope: account.scope })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GOOGLE_ADS_OAUTH_PROVIDER_ID),
      ),
    );
}

async function getOwnedGrant(
  userId: string,
  grantAccountId: string,
): Promise<GoogleAdsGrant | null> {
  const rows = await db
    .select({ accountId: account.accountId, scope: account.scope })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GOOGLE_ADS_OAUTH_PROVIDER_ID),
        eq(account.accountId, grantAccountId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** True when the granted scopes contain exactly the Ads scope. Scope strings
 *  are whitespace/comma separated, so they are split before the exact match. */
function hasAdsConsent(scope: string | null): boolean {
  return Boolean(scope?.split(/[\s,]+/).includes(GOOGLE_ADS_ADWORDS_SCOPE));
}

export const GoogleAdsGrantRepository = {
  listForUser,
  getOwnedGrant,
  hasAdsConsent,
};
