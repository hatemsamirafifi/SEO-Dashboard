import { AppError } from "@/server/lib/errors";
import {
  createGoogleAdsClient,
  type GoogleAdsCustomer,
  type GoogleAdsHierarchyResult,
} from "@/server/lib/googleAdsClient";
import { formatGoogleAdsCustomerId } from "@/shared/google-ads";
import { GoogleAdsGrantRepository } from "../repositories/GoogleAdsGrantRepository";
import {
  googleAdsFailure,
  requireConsentedGoogleAdsGrant,
  requireGoogleAdsCustomerId,
  type GoogleAdsFailure,
} from "./GoogleAdsService";

/** Global discovery ceilings. They bound ONE discovery call across every
 *  grant and every root account, so a user with many Google accounts cannot
 *  turn a single click into an unbounded number of Ads API calls. The client's
 *  own per-page ceilings still apply on top of these. */
export const GOOGLE_ADS_MAX_DISCOVERY_GRANTS = 5;
export const GOOGLE_ADS_MAX_DISCOVERY_ROOTS = 25;
export const GOOGLE_ADS_MAX_DISCOVERY_CHILDREN = 200;

/** A customer account as surfaced by discovery. */
export type GoogleAdsDiscoveredCustomer = {
  customerId: string;
  formattedId: string;
  displayName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  isTestAccount: boolean;
  /** Hierarchy depth; null for a directly accessible account. */
  level: number | null;
};

export type GoogleAdsDiscoveryGrant = {
  grantAccountId: string;
  customers: GoogleAdsDiscoveredCustomer[];
  /** Set when the grant could not be probed. A failed or malformed grant is
   *  never reported as a complete empty list. */
  failure: GoogleAdsFailure | null;
};

export type GoogleAdsDiscoveryResult = {
  grants: GoogleAdsDiscoveryGrant[];
  /** True when a ceiling cut the result short or a grant failed: the list is
   *  not the complete set of accounts the caller can reach. */
  partial: boolean;
  /** Grants that were not probed because of the grant ceiling. */
  skippedGrants: number;
  /** Root accounts that were not classified because of the root ceiling. */
  skippedCustomers: number;
};

export type GoogleAdsManagerChildrenResult = {
  managerId: string;
  grantAccountId: string;
  children: GoogleAdsDiscoveredCustomer[];
  /** The upstream traversal hit its page or row ceiling. */
  truncated: boolean;
  /** Rows the upstream returned that could not be parsed. */
  malformedRows: number;
  /** The children are NOT the complete set of accounts under the manager. */
  partial: boolean;
  /** Set when the expansion could not run at all. */
  failure: GoogleAdsFailure | null;
};

function toDiscoveredCustomer(
  customer: GoogleAdsCustomer,
  level: number | null,
): GoogleAdsDiscoveredCustomer {
  return {
    customerId: customer.customerId,
    formattedId: customer.formattedId,
    displayName: customer.displayName,
    currencyCode: customer.currencyCode,
    timeZone: customer.timeZone,
    manager: customer.manager,
    isTestAccount: customer.isTestAccount,
    level,
  };
}

/** Direct discovery: the accounts each Ads grant can reach on its own. Every
 *  grant is probed with its own client, so one revoked grant never hides the
 *  accounts of another one. */
export async function discoverAccessibleCustomers(input: {
  userId: string;
  grantAccountId?: string;
}): Promise<GoogleAdsDiscoveryResult> {
  const owned = await GoogleAdsGrantRepository.listForUser(input.userId);
  const consented = owned.filter((grant) =>
    GoogleAdsGrantRepository.hasAdsConsent(grant.scope),
  );
  let selected = consented;
  if (input.grantAccountId) {
    // A named grant must be the caller's own and must carry Ads consent.
    await requireConsentedGoogleAdsGrant(input.userId, input.grantAccountId);
    selected = consented.filter(
      (grant) => grant.accountId === input.grantAccountId,
    );
  }

  const probed = selected.slice(0, GOOGLE_ADS_MAX_DISCOVERY_GRANTS);
  let remainingRoots = GOOGLE_ADS_MAX_DISCOVERY_ROOTS;
  let skippedCustomers = 0;
  const grants: GoogleAdsDiscoveryGrant[] = [];

  for (const grant of probed) {
    const client = createGoogleAdsClient({
      userId: input.userId,
      grantAccountId: grant.accountId,
    });
    let accessible: string[];
    try {
      accessible = await client.listAccessibleCustomers();
    } catch (error) {
      grants.push({
        grantAccountId: grant.accountId,
        customers: [],
        failure: googleAdsFailure(error),
      });
      continue;
    }

    const customers: GoogleAdsDiscoveredCustomer[] = [];
    let failure: GoogleAdsFailure | null = null;
    for (const customerId of accessible) {
      if (remainingRoots <= 0) {
        skippedCustomers += 1;
        continue;
      }
      remainingRoots -= 1;
      let customer: GoogleAdsCustomer | null;
      try {
        customer = await client.getCustomer(customerId);
      } catch (error) {
        const classified = googleAdsFailure(error);
        if (
          classified.errorClass === "OAUTH_TOKEN_FAILURE" ||
          classified.errorClass === "OAUTH_TOKEN_INVALID" ||
          classified.errorClass === "API_ACCESS_RESTRICTED"
        ) {
          failure = classified;
          break;
        }
        // An individual root customer that is deactivated, not enabled, or
        // inaccessible is skipped so remaining active accounts can be found.
        skippedCustomers += 1;
        continue;
      }
      if (!customer) {
        skippedCustomers += 1;
        continue;
      }
      customers.push(toDiscoveredCustomer(customer, null));
    }
    grants.push({ grantAccountId: grant.accountId, customers, failure });
  }

  return {
    grants,
    partial:
      selected.length > probed.length ||
      skippedCustomers > 0 ||
      grants.some((grant) => grant.failure !== null),
    skippedGrants: selected.length - probed.length,
    skippedCustomers,
  };
}

/** Explicit expansion of ONE accessible manager root. The traversal is bounded
 *  by the client's own ceilings and its partial state is reported as-is: a
 *  truncated or malformed result is never presented as the full hierarchy. */
export async function listManagerChildren(input: {
  userId: string;
  grantAccountId: string;
  managerId: string;
}): Promise<GoogleAdsManagerChildrenResult> {
  // Discovery is also callable internally: the manager id is normalized with
  // the shared normalizer here, never only at the server-function validator.
  const managerId = requireGoogleAdsCustomerId(input.managerId);
  await requireConsentedGoogleAdsGrant(input.userId, input.grantAccountId);
  const client = createGoogleAdsClient({
    userId: input.userId,
    grantAccountId: input.grantAccountId,
  });

  const failed = (
    failure: GoogleAdsFailure,
  ): GoogleAdsManagerChildrenResult => ({
    managerId,
    grantAccountId: input.grantAccountId,
    children: [],
    truncated: false,
    malformedRows: 0,
    partial: true,
    failure,
  });

  let accessible: string[];
  try {
    accessible = await client.listAccessibleCustomers();
  } catch (error) {
    return failed(googleAdsFailure(error));
  }
  if (!accessible.includes(managerId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google Ads manager account isn't available on your connected Google account.",
    );
  }

  let manager: GoogleAdsCustomer | null;
  try {
    manager = await client.getCustomer(managerId);
  } catch (error) {
    return failed(googleAdsFailure(error));
  }
  if (manager && manager.customerId !== managerId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google Ads returned a different customer than the one requested.",
    );
  }
  if (!manager?.manager) {
    throw new AppError(
      "VALIDATION_ERROR",
      "That Google Ads account is not a manager account.",
    );
  }

  let hierarchy: GoogleAdsHierarchyResult;
  try {
    hierarchy = await client.listCustomerHierarchy(managerId);
  } catch (error) {
    return failed(googleAdsFailure(error));
  }

  // The queried manager itself comes back as a level-0 entry: it is the root,
  // not one of its clients.
  const childEntries = hierarchy.entries.filter(
    (entry) => entry.customerId !== managerId,
  );
  const children = childEntries
    .slice(0, GOOGLE_ADS_MAX_DISCOVERY_CHILDREN)
    .map((entry) => ({
      customerId: entry.customerId,
      formattedId: formatGoogleAdsCustomerId(entry.customerId),
      displayName: entry.displayName,
      currencyCode: entry.currencyCode,
      timeZone: entry.timeZone,
      manager: entry.manager,
      isTestAccount: entry.testAccount,
      level: entry.level,
    }));

  return {
    managerId,
    grantAccountId: input.grantAccountId,
    children,
    truncated: hierarchy.truncated,
    malformedRows: hierarchy.malformedRows,
    partial: hierarchy.partial || children.length < childEntries.length,
    failure: null,
  };
}
