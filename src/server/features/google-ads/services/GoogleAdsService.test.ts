import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GoogleAdsClientModule from "@/server/lib/googleAdsClient";
import type * as GoogleAdsGrantRepositoryModule from "../repositories/GoogleAdsGrantRepository";

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  upsert: vi.fn(),
  deleteByProjectId: vi.fn(),
  existsForConnectorAccount: vi.fn(),
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

vi.mock("../repositories/GoogleAdsConnectionRepository", () => ({
  GoogleAdsConnectionRepository: {
    getByProjectId: mocks.getByProjectId,
    upsert: mocks.upsert,
    deleteByProjectId: mocks.deleteByProjectId,
    existsForConnectorAccount: mocks.existsForConnectorAccount,
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

import { GoogleAdsService } from "./GoogleAdsService";
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

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    projectId: "project-1",
    organizationId: "org-1",
    customerId: CUSTOMER_ID,
    loginCustomerId: null,
    customerDisplayName: "Client store",
    grantAccountId: "google-sub-1",
    connectedByUserId: "user-1",
    currencyCode: "EUR",
    timeZone: null,
    isTestAccount: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function selectInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    userId: "user-1",
    grantAccountId: "google-sub-1",
    customerId: CUSTOMER_ID,
    ...overrides,
  };
}

beforeEach(() => {
  resetGoogleAdsFixture();
  mocks.getOwnedGrant.mockResolvedValue({
    accountId: "google-sub-1",
    scope: ADWORDS_SCOPE,
  });
  mocks.listForUser.mockResolvedValue([]);
  mocks.getByProjectId.mockResolvedValue(null);
  mocks.upsert.mockImplementation(async (input: unknown) => input);
  mocks.deleteByProjectId.mockResolvedValue(undefined);
});

describe("GoogleAdsService database-only reads", () => {
  it("reads the project connection without minting a token or calling the Ads API", async () => {
    const row = connectionRow();
    mocks.getByProjectId.mockResolvedValue(row);

    await expect(
      GoogleAdsService.getConnection("project-1", "org-1"),
    ).resolves.toEqual(row);
    expect(mocks.getByProjectId).toHaveBeenCalledWith("project-1", "org-1");
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("reports the caller's Ads grant from the database alone", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-1", scope: ADWORDS_SCOPE },
      { accountId: "google-sub-2", scope: "openid" },
    ]);

    await expect(GoogleAdsService.userHasGrant("user-1")).resolves.toBe(true);
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("reports no grant when the caller only holds unrelated scopes", async () => {
    mocks.listForUser.mockResolvedValue([
      { accountId: "google-sub-2", scope: "openid email" },
    ]);

    await expect(GoogleAdsService.userHasGrant("user-1")).resolves.toBe(false);
    expect(googleAdsClientCalls).toHaveLength(0);
  });
});

describe("GoogleAdsService customer selection", () => {
  it("stores a directly accessible customer with the currency and time zone Google reported", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: {
        [CUSTOMER_ID]: {
          customerId: CUSTOMER_ID,
          displayName: "Client store",
          currencyCode: "EUR",
          timeZone: "Europe/Lisbon",
        },
      },
    });

    const connection = await GoogleAdsService.selectCustomer(selectInput());

    expect(mocks.upsert).toHaveBeenCalledWith({
      projectId: "project-1",
      organizationId: "org-1",
      customerId: CUSTOMER_ID,
      loginCustomerId: null,
      customerDisplayName: "Client store",
      grantAccountId: "google-sub-1",
      connectedByUserId: "user-1",
      currencyCode: "EUR",
      timeZone: "Europe/Lisbon",
      isTestAccount: false,
    });
    expect(connection.customerId).toBe(CUSTOMER_ID);
  });

  it("keeps a missing currency and time zone as null instead of guessing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    await GoogleAdsService.selectCustomer(selectInput());

    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ currencyCode: null, timeZone: null }),
    );
  });

  it("keeps the test-account identity of the selected customer", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: {
        [CUSTOMER_ID]: { customerId: CUSTOMER_ID, isTestAccount: true },
      },
    });

    await GoogleAdsService.selectCustomer(selectInput());

    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ isTestAccount: true }),
    );
  });

  it("refuses an account the grant cannot reach and stores nothing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [OTHER_CUSTOMER_ID] },
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    await expect(
      GoogleAdsService.selectCustomer(selectInput()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a grant the caller does not own and stores nothing", async () => {
    mocks.getOwnedGrant.mockResolvedValue(null);

    await expect(
      GoogleAdsService.selectCustomer(selectInput()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("refuses a grant without Ads consent and stores nothing", async () => {
    mocks.getOwnedGrant.mockResolvedValue({
      accountId: "google-sub-1",
      scope: "openid email",
    });

    await expect(
      GoogleAdsService.selectCustomer(selectInput()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("reads a manager child through the manager login and stores the manager", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [MANAGER_ID] },
      customers: {
        [MANAGER_ID]: { customerId: MANAGER_ID, manager: true },
        [CUSTOMER_ID]: { customerId: CUSTOMER_ID, displayName: "Child" },
      },
    });

    await GoogleAdsService.selectCustomer(
      selectInput({ loginCustomerId: MANAGER_ID }),
    );

    expect(
      googleAdsClientCalls.filter((call) => call.method === "getCustomer"),
    ).toEqual([
      {
        method: "getCustomer",
        grantAccountId: "google-sub-1",
        customerId: MANAGER_ID,
        loginCustomerId: null,
      },
      {
        method: "getCustomer",
        grantAccountId: "google-sub-1",
        customerId: CUSTOMER_ID,
        loginCustomerId: MANAGER_ID,
      },
    ]);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: CUSTOMER_ID,
        loginCustomerId: MANAGER_ID,
      }),
    );
  });

  it("refuses a forged manager root and stores nothing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: {
        [MANAGER_ID]: { customerId: MANAGER_ID, manager: true },
        [CUSTOMER_ID]: { customerId: CUSTOMER_ID },
      },
    });

    await expect(
      GoogleAdsService.selectCustomer(
        selectInput({ loginCustomerId: MANAGER_ID }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a login account that is not a manager and stores nothing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    await expect(
      GoogleAdsService.selectCustomer(
        selectInput({ loginCustomerId: CUSTOMER_ID }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a response for a different customer and stores nothing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: {
        [CUSTOMER_ID]: { customerId: OTHER_CUSTOMER_ID },
      },
    });

    await expect(
      GoogleAdsService.selectCustomer(selectInput()),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a login manager response for a different customer and stores nothing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [MANAGER_ID] },
      customers: {
        [MANAGER_ID]: { customerId: OTHER_CUSTOMER_ID, manager: true },
        [CUSTOMER_ID]: { customerId: CUSTOMER_ID },
      },
    });

    await expect(
      GoogleAdsService.selectCustomer(
        selectInput({ loginCustomerId: MANAGER_ID }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Nothing is persisted when the manager read does not match the request.
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("normalizes formatted customer ids before any Google Ads call and stores nothing on invalid input", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [CUSTOMER_ID] },
      customers: {
        [CUSTOMER_ID]: { customerId: CUSTOMER_ID, displayName: "Client store" },
      },
    });

    await GoogleAdsService.selectCustomer(
      selectInput({ customerId: "489-751-3260" }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID }),
    );

    await expect(
      GoogleAdsService.selectCustomer({
        ...selectInput(),
        customerId: "4e9751326.0",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(googleAdsClientCalls).toHaveLength(2);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses a manager account as the analytics account and stores nothing", async () => {
    setGoogleAdsScenario({
      accessible: { "google-sub-1": [MANAGER_ID] },
      customers: { [MANAGER_ID]: { customerId: MANAGER_ID, manager: true } },
    });

    await expect(
      GoogleAdsService.selectCustomer(selectInput({ customerId: MANAGER_ID })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("GoogleAdsService disconnect", () => {
  it("removes only the scoped project connection and keeps shared grants", async () => {
    await GoogleAdsService.disconnect({
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(mocks.deleteByProjectId).toHaveBeenCalledWith("project-1", "org-1");
    // The shared OAuth grant and every other project stay untouched.
    expect(mocks.existsForConnectorAccount).not.toHaveBeenCalled();
    expect(mocks.listForUser).not.toHaveBeenCalled();
    expect(mocks.getOwnedGrant).not.toHaveBeenCalled();
  });
});
