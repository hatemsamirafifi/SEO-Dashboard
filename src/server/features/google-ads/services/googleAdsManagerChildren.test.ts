import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GoogleAdsClientModule from "@/server/lib/googleAdsClient";
import type * as GoogleAdsGrantRepositoryModule from "../repositories/GoogleAdsGrantRepository";

const mocks = vi.hoisted(() => ({
  listForUser: vi.fn(),
  getOwnedGrant: vi.fn(),
  upsertConnection: vi.fn(),
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

vi.mock("../repositories/GoogleAdsConnectionRepository", () => ({
  GoogleAdsConnectionRepository: {
    upsert: mocks.upsertConnection,
  },
}));

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

import { GoogleAdsApiError } from "@/server/lib/googleAdsClient";
import { listManagerChildren } from "./googleAdsDiscovery";
import {
  googleAdsClientCalls,
  resetGoogleAdsFixture,
  setGoogleAdsScenario,
} from "./googleAdsTestFixtures";

const ADWORDS_SCOPE =
  "openid email profile https://www.googleapis.com/auth/adwords";
const MANAGER_ID = "3216549870";
const CUSTOMER_ID = "4897513260";
const OTHER_CUSTOMER_ID = "1567432098";

function managerScenario(overrides: Record<string, unknown> = {}) {
  return {
    accessible: { "google-sub-1": [MANAGER_ID] },
    customers: { [MANAGER_ID]: { customerId: MANAGER_ID, manager: true } },
    hierarchies: {
      [MANAGER_ID]: {
        entries: [
          { customerId: MANAGER_ID, level: 0, manager: true },
          { customerId: CUSTOMER_ID, level: 1, displayName: "Client store" },
        ],
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetGoogleAdsFixture();
  mocks.listForUser.mockResolvedValue([]);
  mocks.getOwnedGrant.mockResolvedValue({
    accountId: "google-sub-1",
    scope: ADWORDS_SCOPE,
  });
  mocks.upsertConnection.mockResolvedValue({});
});

describe("Google Ads manager child discovery", () => {
  it("returns the clients of an accessible manager root", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [MANAGER_ID] },
      customers: { [MANAGER_ID]: { customerId: MANAGER_ID, manager: true } },
      hierarchies: {
        [MANAGER_ID]: {
          entries: [
            { customerId: MANAGER_ID, level: 0, manager: true },
            { customerId: CUSTOMER_ID, level: 1, displayName: "Client store" },
            { customerId: OTHER_CUSTOMER_ID, level: 1 },
          ],
        },
      },
    });

    const result = await listManagerChildren({
      userId: "user-1",
      grantAccountId: "google-sub-1",
      managerId: MANAGER_ID,
    });

    expect(result.children.map((child) => child.customerId)).toEqual([
      CUSTOMER_ID,
      OTHER_CUSTOMER_ID,
    ]);
    expect(result.children[0]).toMatchObject({
      formattedId: "489-751-3260",
      displayName: "Client store",
      level: 1,
    });
    expect(result.partial).toBe(false);
    expect(result.failure).toBeNull();
  });

  it("refuses a manager root the grant cannot reach", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: { [MANAGER_ID]: { customerId: MANAGER_ID, manager: true } },
    });

    await expect(
      listManagerChildren({
        userId: "user-1",
        grantAccountId: "google-sub-1",
        managerId: MANAGER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a root that is not a manager account", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    await expect(
      listManagerChildren({
        userId: "user-1",
        grantAccountId: "google-sub-1",
        managerId: CUSTOMER_ID,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a grant the caller does not own", async () => {
    mocks.getOwnedGrant.mockResolvedValue(null);

    await expect(
      listManagerChildren({
        userId: "user-1",
        grantAccountId: "google-sub-1",
        managerId: MANAGER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a response for a different manager and never expands a child", async () => {
    setGoogleAdsScenario(
      managerScenario({
        customers: {
          [MANAGER_ID]: { customerId: OTHER_CUSTOMER_ID, manager: true },
        },
      }),
    );

    await expect(
      listManagerChildren({
        userId: "user-1",
        grantAccountId: "google-sub-1",
        managerId: MANAGER_ID,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // The mismatched manager read must end the expansion before any child is
    // authorized: no hierarchy query at all, and nothing is persisted.
    expect(googleAdsClientCalls.map((call) => call.method)).toEqual([
      "listAccessibleCustomers",
      "getCustomer",
    ]);
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it("normalizes a formatted manager id to the bare ten-digit form", async () => {
    setGoogleAdsScenario(managerScenario());

    const result = await listManagerChildren({
      userId: "user-1",
      grantAccountId: "google-sub-1",
      managerId: "321 654 9870",
    });

    expect(result.managerId).toBe(MANAGER_ID);
    const reads = googleAdsClientCalls.filter(
      (call) => call.method !== "listAccessibleCustomers",
    );
    expect(reads).toEqual([
      {
        method: "getCustomer",
        grantAccountId: "google-sub-1",
        customerId: MANAGER_ID,
        loginCustomerId: null,
      },
      {
        method: "listCustomerHierarchy",
        grantAccountId: "google-sub-1",
        managerId: MANAGER_ID,
        loginCustomerId: null,
      },
    ]);
  });

  it("rejects an invalid manager id even when called internally", async () => {
    await expect(
      listManagerChildren({
        userId: "user-1",
        grantAccountId: "google-sub-1",
        managerId: "not-a-customer",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(googleAdsClientCalls).toHaveLength(0);
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it("exposes a truncated hierarchy and malformed rows as a partial result", async () => {
    setGoogleAdsScenario(
      managerScenario({
        hierarchies: {
          [MANAGER_ID]: {
            entries: [
              { customerId: MANAGER_ID, level: 0, manager: true },
              { customerId: CUSTOMER_ID, level: 1 },
            ],
            truncated: true,
            malformedRows: 2,
          },
        },
      }),
    );

    const result = await listManagerChildren({
      userId: "user-1",
      grantAccountId: "google-sub-1",
      managerId: MANAGER_ID,
    });

    expect(result.truncated).toBe(true);
    expect(result.malformedRows).toBe(2);
    expect(result.partial).toBe(true);
  });

  it("reports a provider failure instead of an empty child list", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [MANAGER_ID] },
      customers: { [MANAGER_ID]: { customerId: MANAGER_ID, manager: true } },
      hierarchyErrors: {
        [MANAGER_ID]: new GoogleAdsApiError(
          429,
          "Google Ads API error (429).",
          "QuotaError.RESOURCE_EXHAUSTED",
        ),
      },
    });

    const result = await listManagerChildren({
      userId: "user-1",
      grantAccountId: "google-sub-1",
      managerId: MANAGER_ID,
    });

    expect(result.failure).toMatchObject({
      errorClass: "QUOTA_EXHAUSTED",
      retryable: false,
    });
    expect(result.children).toHaveLength(0);
    expect(result.partial).toBe(true);
  });
});
