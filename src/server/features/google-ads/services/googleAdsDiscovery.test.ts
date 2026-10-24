import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GoogleAdsClientModule from "@/server/lib/googleAdsClient";
import type * as GoogleAdsGrantRepositoryModule from "../repositories/GoogleAdsGrantRepository";

const mocks = vi.hoisted(() => ({
  listForUser: vi.fn(),
  getOwnedGrant: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/server/lib/googleAdsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleAdsClientModule>();
  const fixtures = await import("./googleAdsTestFixtures");
  return {
    ...actual,
    createGoogleAdsClient: fixtures.createFakeGoogleAdsClient,
  };
});

vi.mock("../repositories/GoogleAdsGrantRepository", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleAdsGrantRepositoryModule>();
  return {
    GoogleAdsGrantRepository: {
      listForUser: mocks.listForUser,
      getOwnedGrant: mocks.getOwnedGrant,
      hasAdsConsent: actual.GoogleAdsGrantRepository.hasAdsConsent,
    },
  };
});

import {
  GoogleAdsApiError,
  GoogleAdsTokenError,
} from "@/server/lib/googleAdsClient";
import {
  GOOGLE_ADS_MAX_DISCOVERY_GRANTS,
  GOOGLE_ADS_MAX_DISCOVERY_ROOTS,
  discoverAccessibleCustomers,
} from "./googleAdsDiscovery";
import {
  googleAdsClientCalls,
  resetGoogleAdsFixture,
  setGoogleAdsScenario,
} from "./googleAdsTestFixtures";

const ADWORDS_SCOPE =
  "openid email profile https://www.googleapis.com/auth/adwords";
const CUSTOMER_ID = "4897513260";
const MANAGER_ID = "3216549870";
const OTHER_CUSTOMER_ID = "1567432098";

function customerId(index: number): string {
  return String(1000000000 + index);
}

beforeEach(() => {
  resetGoogleAdsFixture();
  mocks.listForUser.mockResolvedValue([]);
  mocks.getOwnedGrant.mockResolvedValue({
    accountId: "google-sub-1",
    scope: ADWORDS_SCOPE,
  });
});

describe("Google Ads direct account discovery", () => {
  it("returns the accounts each consented grant can reach, grouped per grant", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: ADWORDS_SCOPE },
      { accountId: "google-sub-2", scope: ADWORDS_SCOPE },
    ]);
    setGoogleAdsScenario({
      accessible: {
        "google-sub-1": [CUSTOMER_ID, MANAGER_ID],
        "google-sub-2": [OTHER_CUSTOMER_ID],
      },
      customers: {
        [CUSTOMER_ID]: { customerId: CUSTOMER_ID, displayName: "Client store" },
        [MANAGER_ID]: { customerId: MANAGER_ID, manager: true },
        [OTHER_CUSTOMER_ID]: { customerId: OTHER_CUSTOMER_ID },
      },
    });

    const result = await discoverAccessibleCustomers({ userId: "user-1" });

    expect(result.grants).toHaveLength(2);
    expect(result.grants[0]).toMatchObject({
      grantAccountId: "google-sub-1",
      failure: null,
    });
    expect(
      result.grants[0]?.customers.map((entry) => entry.customerId),
    ).toEqual([CUSTOMER_ID, MANAGER_ID]);
    expect(result.grants[0]?.customers[1]).toMatchObject({ manager: true });
    expect(result.grants[1]?.customers).toHaveLength(1);
    expect(result.partial).toBe(false);
  });

  it("never probes a grant without Ads consent", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: "openid email" },
    ]);

    const result = await discoverAccessibleCustomers({ userId: "user-1" });

    expect(result.grants).toHaveLength(0);
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("reports a revoked grant as a failure instead of a complete empty list", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: ADWORDS_SCOPE },
      { accountId: "google-sub-2", scope: ADWORDS_SCOPE },
    ]);
    setGoogleAdsScenario({
      accessible: { "google-sub-2": [OTHER_CUSTOMER_ID] },
      customers: { [OTHER_CUSTOMER_ID]: { customerId: OTHER_CUSTOMER_ID } },
      listErrors: { "google-sub-1": new GoogleAdsTokenError() },
    });

    const result = await discoverAccessibleCustomers({ userId: "user-1" });

    expect(result.grants[0]).toMatchObject({
      grantAccountId: "google-sub-1",
      customers: [],
      failure: { errorClass: "OAUTH_TOKEN_FAILURE", retryable: false },
    });
    // The healthy grant is still listed, and the result is marked partial.
    expect(result.grants[1]?.customers).toHaveLength(1);
    expect(result.partial).toBe(true);
  });

  it("never reports a malformed accessible-customer response as complete empty", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: ADWORDS_SCOPE },
    ]);
    setGoogleAdsScenario({
      listErrors: {
        "google-sub-1": new GoogleAdsApiError(
          500,
          "Google Ads API error (500).",
        ),
      },
    });

    const result = await discoverAccessibleCustomers({ userId: "user-1" });

    expect(result.grants[0]?.failure?.errorClass).toBe("HTTP_ERROR_500");
    expect(result.partial).toBe(true);
  });

  it("caps the number of probed grants globally", async () => {
    const grants = Array.from(
      { length: GOOGLE_ADS_MAX_DISCOVERY_GRANTS + 2 },
      (_, index) => ({
        accountId: `google-sub-${index}`,
        scope: ADWORDS_SCOPE,
      }),
    );
    mocks.listForUser.mockResolvedValue(grants);
    setGoogleAdsScenario({
      accessible: Object.fromEntries(
        grants.map((grant) => [grant.accountId, [CUSTOMER_ID]]),
      ),
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    const result = await discoverAccessibleCustomers({ userId: "user-1" });

    expect(result.grants).toHaveLength(GOOGLE_ADS_MAX_DISCOVERY_GRANTS);
    expect(result.skippedGrants).toBe(2);
    expect(result.partial).toBe(true);
  });

  it("caps the number of classified root accounts globally", async () => {
    const accessible = Array.from(
      { length: GOOGLE_ADS_MAX_DISCOVERY_ROOTS + 3 },
      (_, index) => customerId(index),
    );
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: ADWORDS_SCOPE },
    ]);
    setGoogleAdsScenario({
      accessible: { "google-sub-1": accessible },
      customers: Object.fromEntries(
        accessible.map((id) => [id, { customerId: id }]),
      ),
    });

    const result = await discoverAccessibleCustomers({ userId: "user-1" });

    expect(result.grants[0]?.customers).toHaveLength(
      GOOGLE_ADS_MAX_DISCOVERY_ROOTS,
    );
    expect(result.skippedCustomers).toBe(3);
    expect(result.partial).toBe(true);
  });

  it("scopes discovery to one named grant and refuses a grant the caller does not own", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: ADWORDS_SCOPE },
    ]);
    mocks.getOwnedGrant.mockResolvedValue({
      accountId: "google-sub-1",
      scope: ADWORDS_SCOPE,
    });
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    const scoped = await discoverAccessibleCustomers({
      userId: "user-1",
      grantAccountId: "google-sub-1",
    });
    expect(scoped.grants).toHaveLength(1);

    mocks.getOwnedGrant.mockResolvedValue(null);
    await expect(
      discoverAccessibleCustomers({
        userId: "user-1",
        grantAccountId: "google-sub-other",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a named grant that lost its Ads consent", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: "openid email" },
    ]);
    mocks.getOwnedGrant.mockResolvedValue({
      accountId: "google-sub-1",
      scope: "openid email",
    });

    await expect(
      discoverAccessibleCustomers({
        userId: "user-1",
        grantAccountId: "google-sub-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
