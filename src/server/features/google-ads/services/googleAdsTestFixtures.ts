import type {
  GoogleAdsCustomer,
  GoogleAdsHierarchyResult,
} from "@/server/lib/googleAdsClient";
import { formatGoogleAdsCustomerId } from "@/shared/google-ads";

/* Deterministic Ads client fixture. The service logic runs for real against
 * this fake: only the transport (token minting, HTTP, pagination) is
 * replaced, so the tests never touch the Google Ads API. */

export type GoogleAdsCustomerFixture = {
  customerId: string;
  displayName?: string | null;
  currencyCode?: string | null;
  timeZone?: string | null;
  manager?: boolean;
  isTestAccount?: boolean;
};

export type GoogleAdsHierarchyFixture = {
  entries: Array<{
    customerId: string;
    level?: number;
    manager?: boolean;
    testAccount?: boolean;
    displayName?: string | null;
    currencyCode?: string | null;
    timeZone?: string | null;
  }>;
  truncated?: boolean;
  malformedRows?: number;
};

export type GoogleAdsScenario = {
  /** Accessible customer ids per grant account id. */
  accessible?: Record<string, string[]>;
  /** Customers keyed by the requested id. The fixture's `customerId` is what
   *  the fake returns, so a mismatching entry simulates a wrong response. */
  customers?: Record<string, GoogleAdsCustomerFixture>;
  /** Hierarchy results keyed by manager id. */
  hierarchies?: Record<string, GoogleAdsHierarchyFixture>;
  /** Errors thrown by listAccessibleCustomers, keyed by grant account id. */
  listErrors?: Record<string, Error>;
  /** Errors thrown by getCustomer, keyed by customer id. */
  customerErrors?: Record<string, Error>;
  /** Errors thrown by listCustomerHierarchy, keyed by manager id. */
  hierarchyErrors?: Record<string, Error>;
};

export type GoogleAdsClientCall = {
  method: "listAccessibleCustomers" | "getCustomer" | "listCustomerHierarchy";
  grantAccountId: string;
  customerId?: string;
  loginCustomerId?: string | null;
  managerId?: string;
};

let scenario: GoogleAdsScenario = {};

/** Every client call the service made, in order. */
export const googleAdsClientCalls: GoogleAdsClientCall[] = [];

export function setGoogleAdsScenario(next: GoogleAdsScenario): void {
  scenario = next;
}

export function resetGoogleAdsFixture(): void {
  scenario = {};
  googleAdsClientCalls.length = 0;
}

function toCustomer(fixture: GoogleAdsCustomerFixture): GoogleAdsCustomer {
  return {
    resourceName: `customers/${fixture.customerId}`,
    customerId: fixture.customerId,
    formattedId: formatGoogleAdsCustomerId(fixture.customerId),
    displayName: fixture.displayName ?? null,
    currencyCode: fixture.currencyCode ?? null,
    timeZone: fixture.timeZone ?? null,
    manager: fixture.manager ?? false,
    isTestAccount: fixture.isTestAccount ?? false,
    status: "ENABLED",
  };
}

export function createFakeGoogleAdsClient(options: {
  userId: string;
  grantAccountId: string;
}) {
  const { grantAccountId } = options;
  return {
    async listAccessibleCustomers(): Promise<string[]> {
      googleAdsClientCalls.push({
        method: "listAccessibleCustomers",
        grantAccountId,
      });
      const failure = scenario.listErrors?.[grantAccountId];
      if (failure) throw failure;
      return scenario.accessible?.[grantAccountId] ?? [];
    },

    async getCustomer(
      customerId: string,
      input: { loginCustomerId?: string | null } = {},
    ): Promise<GoogleAdsCustomer | null> {
      googleAdsClientCalls.push({
        method: "getCustomer",
        grantAccountId,
        customerId,
        loginCustomerId: input.loginCustomerId ?? null,
      });
      const failure = scenario.customerErrors?.[customerId];
      if (failure) throw failure;
      const fixture = scenario.customers?.[customerId];
      return fixture ? toCustomer(fixture) : null;
    },

    async listCustomerHierarchy(
      managerId: string,
      input: { loginCustomerId?: string | null } = {},
    ): Promise<GoogleAdsHierarchyResult> {
      googleAdsClientCalls.push({
        method: "listCustomerHierarchy",
        grantAccountId,
        managerId,
        loginCustomerId: input.loginCustomerId ?? null,
      });
      const failure = scenario.hierarchyErrors?.[managerId];
      if (failure) throw failure;
      const fixture = scenario.hierarchies?.[managerId];
      const entries = (fixture?.entries ?? []).map((entry) => ({
        customerId: entry.customerId,
        managerId,
        level: entry.level ?? 1,
        manager: entry.manager ?? false,
        hidden: false,
        testAccount: entry.testAccount ?? false,
        status: "ENABLED",
        displayName: entry.displayName ?? null,
        currencyCode: entry.currencyCode ?? null,
        timeZone: entry.timeZone ?? null,
      }));
      const truncated = fixture?.truncated ?? false;
      const malformedRows = fixture?.malformedRows ?? 0;
      return {
        entries,
        truncated,
        malformedRows,
        partial: truncated || malformedRows > 0,
      };
    },
  };
}
