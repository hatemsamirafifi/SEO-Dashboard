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

import {
  GoogleAdsApiError,
  GoogleAdsMalformedResponseError,
  GoogleAdsTokenError,
} from "@/server/lib/googleAdsClient";
import { GoogleAdsService } from "./GoogleAdsService";
import {
  googleAdsClientCalls,
  resetGoogleAdsFixture,
  setGoogleAdsScenario,
} from "./googleAdsTestFixtures";

const ADWORDS_SCOPE =
  "openid email profile https://www.googleapis.com/auth/adwords";
const CUSTOMER_ID = "4897513260";

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

function testInput() {
  return { projectId: "project-1", organizationId: "org-1" };
}

beforeEach(() => {
  resetGoogleAdsFixture();
  mocks.getOwnedGrant.mockResolvedValue({
    accountId: "google-sub-1",
    scope: ADWORDS_SCOPE,
  });
  mocks.getByProjectId.mockResolvedValue(null);
});

describe("GoogleAdsService connection test", () => {
  it("reports a working connection after a single customer read", async () => {
    mocks.getByProjectId.mockResolvedValue(connectionRow());
    setGoogleAdsScenario({
      customers: { [CUSTOMER_ID]: { customerId: CUSTOMER_ID } },
    });

    const result = await GoogleAdsService.testConnection(testInput());

    expect(result).toMatchObject({ ok: true, errorClass: null });
    expect(
      googleAdsClientCalls.filter((call) => call.method === "getCustomer"),
    ).toHaveLength(1);
  });

  it("reports a missing connection without calling the Ads API", async () => {
    mocks.getByProjectId.mockResolvedValue(null);

    const result = await GoogleAdsService.testConnection(testInput());

    expect(result).toMatchObject({
      ok: false,
      errorClass: "NOT_CONNECTED",
      retryable: false,
    });
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("reports missing credentials and a missing scope separately", async () => {
    mocks.getByProjectId.mockResolvedValue(connectionRow());
    mocks.getOwnedGrant.mockResolvedValue(null);

    await expect(
      GoogleAdsService.testConnection(testInput()),
    ).resolves.toMatchObject({
      ok: false,
      errorClass: "MISSING_CREDENTIALS",
    });

    mocks.getOwnedGrant.mockResolvedValue({
      accountId: "google-sub-1",
      scope: "openid email",
    });
    await expect(
      GoogleAdsService.testConnection(testInput()),
    ).resolves.toMatchObject({ ok: false, errorClass: "MISSING_SCOPE" });
    expect(googleAdsClientCalls).toHaveLength(0);
  });

  it("reports a customer the Ads API no longer returns", async () => {
    mocks.getByProjectId.mockResolvedValue(connectionRow());
    setGoogleAdsScenario({});

    const result = await GoogleAdsService.testConnection(testInput());

    expect(result).toMatchObject({
      ok: false,
      errorClass: "CUSTOMER_NOT_FOUND",
      retryable: false,
    });
  });

  it("reports a customer that no longer matches the connection", async () => {
    mocks.getByProjectId.mockResolvedValue(connectionRow());
    setGoogleAdsScenario({
      customers: { [CUSTOMER_ID]: { customerId: "1567432098" } },
    });

    const result = await GoogleAdsService.testConnection(testInput());

    expect(result).toMatchObject({
      ok: false,
      errorClass: "CUSTOMER_MISMATCH",
      retryable: false,
    });
  });

  it.each([
    [
      "revoked credentials",
      new GoogleAdsTokenError(),
      "OAUTH_TOKEN_FAILURE",
      false,
    ],
    [
      "an expired grant",
      new GoogleAdsApiError(
        401,
        "Google Ads API error (401).",
        "AuthenticationError.OAUTH_TOKEN_EXPIRED",
      ),
      "OAUTH_TOKEN_INVALID",
      false,
    ],
    [
      "a Cloud access restriction",
      new GoogleAdsApiError(
        403,
        "Google Ads API error (403).",
        "AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      ),
      "API_ACCESS_RESTRICTED",
      false,
    ],
    [
      "an account permission problem",
      new GoogleAdsApiError(403, "Google Ads API error (403)."),
      "PERMISSION_DENIED",
      false,
    ],
    [
      "quota exhaustion",
      new GoogleAdsApiError(
        429,
        "Google Ads API error (429).",
        "QuotaError.RESOURCE_EXHAUSTED",
      ),
      "QUOTA_EXHAUSTED",
      false,
    ],
    [
      "temporarily exhausted quota",
      new GoogleAdsApiError(
        429,
        "Google Ads API error (429).",
        "QuotaError.RESOURCE_TEMPORARILY_EXHAUSTED",
      ),
      "QUOTA_TEMPORARILY_EXHAUSTED",
      true,
    ],
    [
      "a malformed response",
      new GoogleAdsMalformedResponseError(),
      "MALFORMED_RESPONSE",
      false,
    ],
  ])(
    "classifies %s as %s without retrying",
    async (_label, failure, errorClass, retryable) => {
      mocks.getByProjectId.mockResolvedValue(connectionRow());
      setGoogleAdsScenario({
        customerErrors: { [CUSTOMER_ID]: failure },
      });

      const result = await GoogleAdsService.testConnection(testInput());

      expect(result).toMatchObject({ ok: false, errorClass, retryable });
      // One attempt only: a failed test never loops.
      expect(
        googleAdsClientCalls.filter((call) => call.method === "getCustomer"),
      ).toHaveLength(1);
    },
  );
});
