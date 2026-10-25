/* eslint-disable max-lines -- full provider contract suite: supports(), targeting, error provenance and planner dispatch */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Phase 2 — the router-facing google_ads provider consumes the per-project
 * Google Ads connection and the v26 typed Planner client from Phase 1.
 * Every planner fetch here runs through the REAL client over the installed
 * fetch stub, so the contract under test is provider → client → HTTP.
 *
 * Isolation rules pinned here (master plan):
 *  - Identity comes ONLY from the Google Ads connection row via the billing
 *    context (projectId + organizationId). Caller-supplied constraint values
 *    (customerId, userId, grantAccountId) are never trusted.
 *  - No connection resolved → ProviderUnavailableError and zero planner
 *    fetches: DataForSEO keeps serving honestly.
 *  - Unknown/ambiguous geo or language targets are rejected (never defaulted
 *    to US/English) so the DFS fallback can serve its own market instead.
 *  - Every error leaving the provider carries first-party provenance metadata
 *    (errorClass + retryable) so the router can attach it to a successful
 *    fallback response without leaking upstream messages.
 */

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: auth.getAccessToken } }),
}));

const flags = vi.hoisted(() => ({ googleAdsEnabled: true }));
vi.mock("../config", () => ({
  getProviderFeatureFlags: () =>
    Promise.resolve({ googleAdsEnabled: flags.googleAdsEnabled }),
}));

const connectionRepo = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  upsert: vi.fn(),
  deleteByProjectId: vi.fn(),
  existsForConnectorAccount: vi.fn(),
}));
vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository",
  () => ({
    GoogleAdsConnectionRepository: connectionRepo,
  }),
);

import {
  createGoogleAdsProvider,
  resetPlannerTargetMemoForTests,
  type GoogleAdsPlannerCacheIdentity,
} from "./google-ads-provider";
import { ProviderUnavailableError } from "../errors";
import type { SEODataRequest } from "../types";
import {
  BASE,
  CUSTOMER_ID,
  GEO_US,
  LANGUAGE_EN,
  MANAGER_ID,
  adsErrorResponse,
  bodyRecord,
  callAt,
  capture,
  headersOf,
  historicalRow,
  ideaRow,
  installFetchMock,
  jsonResponse,
} from "@/server/lib/googleAdsPlanner.testFixtures";

const CUSTOMER_RESOURCE = `customers/${MANAGER_ID}`;

const CONNECTION = {
  id: "conn-1",
  projectId: "proj-1",
  organizationId: "org-1",
  customerId: CUSTOMER_ID,
  loginCustomerId: MANAGER_ID,
  customerDisplayName: "Test Ads Account",
  grantAccountId: "google-account-1",
  connectedByUserId: "user-1",
  currencyCode: "USD",
  timeZone: "UTC",
  isTestAccount: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function geoSuggestResponse(countryCode: string, id: string, name: string) {
  return jsonResponse({
    geoTargetConstantSuggestions: [
      {
        geoTargetConstant: {
          resourceName: `geoTargetConstants/${id}`,
          id,
          name,
          canonicalName: name,
          countryCode,
          targetType: "Country",
          status: "ENABLED",
        },
      },
    ],
  });
}

function languageConstantResponse(code = "en") {
  return jsonResponse({
    results: [
      {
        languageConstant: {
          resourceName: LANGUAGE_EN,
          id: "1000",
          code,
          name: "English",
          targetable: true,
        },
      },
    ],
  });
}

function ideasRequest(overrides: Partial<SEODataRequest> = {}): SEODataRequest {
  return {
    dataType: "keyword_ideas",
    keyword: "running shoes",
    locationCode: 2840,
    languageCode: "en",
    billingCustomer: {
      organizationId: "org-1",
      projectId: "proj-1",
      userId: "user-1",
      userEmail: "planner-test@example.com",
    },
    constraints: { source: "ideas", limit: 10 },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof installFetchMock>;

type SeoFirstPartyMeta = {
  provider: string;
  errorClass: string;
  message: string;
  retryable: boolean;
};

function firstPartyMetaOf(error: unknown): SeoFirstPartyMeta | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("firstPartyError" in error)
  ) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- first-party meta is attached dynamically to thrown errors (the contract under test)
  const meta = error.firstPartyError as SeoFirstPartyMeta | undefined;
  return meta ?? null;
}

describe("google_ads provider — supports() claims", () => {
  const provider = createGoogleAdsProvider();

  it("claims keyword_ideas across the supported location list", () => {
    expect(provider.supports(ideasRequest())).toBe(true);
    expect(
      provider.supports(
        ideasRequest({ locationCode: 2360, languageCode: "id" }),
      ),
    ).toBe(true);
  });

  it("rejects keyword_ideas without an explicit supported location", () => {
    expect(provider.supports(ideasRequest({ locationCode: 9999 }))).toBe(false);
    expect(provider.supports(ideasRequest({ locationCode: undefined }))).toBe(
      false,
    );
  });

  it("keeps explicit Labs-mode and Google-Ads-only keyword_ideas requests on DataForSEO", () => {
    for (const source of [
      "related",
      "suggestions",
      "clickstream",
      "google_ads",
    ]) {
      expect(
        provider.supports(ideasRequest({ constraints: { source, limit: 10 } })),
      ).toBe(false);
    }
  });

  it("rejects keyword_ideas with a clickstream refinement (DFS-only refinement)", () => {
    expect(
      provider.supports(
        ideasRequest({
          constraints: {
            source: "ideas",
            limit: 10,
            includeClickstreamData: true,
          },
        }),
      ),
    ).toBe(false);
  });

  it("claims keyword_metrics for supported locations but not location-name targeting", () => {
    expect(
      provider.supports({
        dataType: "keyword_metrics",
        keywords: ["alpha"],
        locationCode: 2840,
        languageCode: "en",
        billingCustomer: {
          organizationId: "org-1",
          projectId: "proj-1",
          userId: "user-1",
          userEmail: "planner-test@example.com",
        },
      }),
    ).toBe(true);
    expect(
      provider.supports({
        dataType: "keyword_metrics",
        keywords: ["alpha"],
        locationCode: 2840,
        languageCode: "en",
        billingCustomer: {
          organizationId: "org-1",
          projectId: "proj-1",
          userId: "user-1",
          userEmail: "planner-test@example.com",
        },
        constraints: { locationName: "Portland, Maine, United States" },
      }),
    ).toBe(false);
  });
});

describe("google_ads provider — planner access", () => {
  let provider: ReturnType<typeof createGoogleAdsProvider>;

  beforeEach(() => {
    auth.getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    connectionRepo.getByProjectId.mockReset();
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTION);
    fetchMock = installFetchMock();
    resetPlannerTargetMemoForTests();
    provider = createGoogleAdsProvider();
  });

  it("resolves the connection only from the billing context and runs the planner through the real client", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("US", "2840", "United States"))
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          results: [ideaRow("running shoes", {}, ["runing shoe"])],
          totalSize: "1",
        }),
      );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion — asserting the planner envelope shape the provider contract promises
    const result = (await provider.get(
      ideasRequest({
        constraints: {
          source: "ideas",
          limit: 10,
          customerId: "9999999999",
          userId: "attacker-user",
          grantAccountId: "attacker-account",
        },
      }),
    )) as {
      source: string;
      currencyCode: string;
      ideas: Array<{ keyword: string }>;
    };

    expect(connectionRepo.getByProjectId).toHaveBeenCalledWith(
      "proj-1",
      "org-1",
    );
    // The caller-supplied identity hints are ignored: the plan runs against
    // the connected account.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callAt(fetchMock, 2).url).toBe(
      `${BASE}/customers/${CUSTOMER_ID}:generateKeywordIdeas`,
    );
    expect(result.source).toBe("google_ads");
    expect(result.currencyCode).toBe("USD");
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0].keyword).toBe("running shoes");
  });

  it("sends the resolved geo target constant, language constant and keyword seed", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("US", "2840", "United States"))
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("running shoes")] }),
      );

    await provider.get(ideasRequest());

    const geoCall = bodyRecord(callAt(fetchMock, 0).init);
    expect(geoCall.countryCode).toBe("US");
    expect(geoCall.locationNames).toEqual({ names: ["United States"] });

    const languageCall = bodyRecord(callAt(fetchMock, 1).init);
    expect(String(languageCall.query)).toContain(
      "language_constant.code = 'en'",
    );
    // The language lookup runs against the connected customer via the manager.
    expect(headersOf(callAt(fetchMock, 1).init)["login-customer-id"]).toBe(
      MANAGER_ID,
    );

    const ideasCall = bodyRecord(callAt(fetchMock, 2).init);
    expect(ideasCall.keywordSeed).toEqual({ keywords: ["running shoes"] });
    expect(ideasCall.geoTargetConstants).toEqual([GEO_US]);
    expect(ideasCall.language).toBe(LANGUAGE_EN);
    expect(ideasCall.historicalMetricsOptions).toEqual({
      includeAverageCpc: true,
    });
  });

  it("maps the UK market to the ISO GB code instead of label shorthand", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("GB", "2826", "United Kingdom"))
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("running shoes")] }),
      );

    await provider.get(ideasRequest({ locationCode: 2826 }));

    const geoCall = bodyRecord(callAt(fetchMock, 0).init);
    expect(geoCall.countryCode).toBe("GB");
    expect(geoCall.locationNames).toEqual({ names: ["United Kingdom"] });
    const ideasCall = bodyRecord(callAt(fetchMock, 2).init);
    expect(ideasCall.geoTargetConstants).toEqual(["geoTargetConstants/2826"]);
  });

  it("rejects ambiguous geo targets without fetching ideas and without defaulting to US", async () => {
    const ambiguous = jsonResponse({
      geoTargetConstantSuggestions: [
        {
          geoTargetConstant: {
            resourceName: "geoTargetConstants/2840",
            id: "2840",
            name: "United States",
            countryCode: "US",
            targetType: "Country",
            status: "ENABLED",
          },
        },
        {
          geoTargetConstant: {
            resourceName: "geoTargetConstants/9999",
            id: "9999",
            name: "United States",
            countryCode: "US",
            targetType: "Country",
            status: "ENABLED",
          },
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(ambiguous)
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("running shoes")] }),
      );

    const error = await capture(provider.get(ideasRequest()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const meta = firstPartyMetaOf(error);
    expect(meta).not.toBeNull();
    expect(meta?.errorClass).toBe("PROVIDER_UNSUPPORTED");
    expect(meta?.retryable).toBe(false);
  });

  it("rejects an unknown or missing language code instead of assuming English", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("US", "2840", "United States"))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("running shoes")] }),
      );

    const error = await capture(
      provider.get(ideasRequest({ languageCode: "xx-YY" })),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstPartyMetaOf(error)?.errorClass).toBe("PROVIDER_UNSUPPORTED");

    const missingLanguage = await capture(
      provider.get(ideasRequest({ languageCode: undefined })),
    );
    expect(missingLanguage).toBeInstanceOf(Error);
  });

  it("rejects keyword_ideas without a seed keyword before any fetch", async () => {
    const error = await capture(
      provider.get(ideasRequest({ keyword: undefined })),
    );
    expect(firstPartyMetaOf(error)?.errorClass).toBe("PROVIDER_UNSUPPORTED");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("reports no-connection unavailability without fetching and preserves honest fallback provenance", async () => {
    connectionRepo.getByProjectId.mockResolvedValue(null);
    const error = await capture(provider.get(ideasRequest()));
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(connectionRepo.getByProjectId).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const meta = firstPartyMetaOf(error);
    expect(meta?.provider).toBe("google_ads");
    expect(meta?.errorClass).toBe("PROVIDER_UNAVAILABLE");
    expect(meta?.retryable).toBe(false);
  });

  it("fails closed when the flag is disabled, without touching the connection", async () => {
    flags.googleAdsEnabled = false;
    try {
      const error = await capture(provider.get(ideasRequest()));
      expect(firstPartyMetaOf(error)?.errorClass).toBe("PROVIDER_UNAVAILABLE");
      expect(connectionRepo.getByProjectId).toHaveBeenCalledTimes(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    } finally {
      flags.googleAdsEnabled = true;
    }
  });

  it("attaches sanitized, retryable provenance on quota exhaustion", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("US", "2840", "United States"))
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        adsErrorResponse(429, { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }),
      );

    const error = await capture(provider.get(ideasRequest()));
    const meta = firstPartyMetaOf(error);
    expect(meta?.provider).toBe("google_ads");
    expect(meta?.errorClass).toBe("QUOTA_TEMPORARILY_EXHAUSTED");
    expect(meta?.retryable).toBe(true);
    // The sanitized classification never re-exposes upstream text.
    expect(JSON.stringify(meta)).not.toContain("SECRET-VALUE");
    expect(JSON.stringify(meta)).not.toContain("Raw ads failure");
  });

  it("serves historical metrics through the connected planner for keyword_metrics", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("US", "2840", "United States"))
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          results: [historicalRow("alpha"), historicalRow("beta")],
        }),
      );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion — asserting the metrics envelope shape the provider contract promises
    const result = (await provider.get({
      dataType: "keyword_metrics",
      keywords: ["alpha", "beta"],
      locationCode: 2840,
      languageCode: "en",
      billingCustomer: {
        organizationId: "org-1",
        projectId: "proj-1",
        userId: "user-1",
        userEmail: "planner-test@example.com",
      },
    })) as {
      source: string;
      currencyCode: string;
      keywords: Array<{ keyword: string }>;
      missingKeywords: string[];
      malformedKeywords: number;
      duplicateKeywords: number;
      truncated: boolean;
      partial: boolean;
      fetchedAt: string;
      network: string;
    };

    expect(callAt(fetchMock, 2).url).toBe(
      `${BASE}/customers/${CUSTOMER_ID}:generateKeywordHistoricalMetrics`,
    );
    const body = bodyRecord(callAt(fetchMock, 2).init);
    expect(body.keywords).toEqual(["alpha", "beta"]);
    // The historical-metrics endpoint has no paging contract.
    expect(body).not.toHaveProperty("pageSize");

    expect(result.source).toBe("google_ads");
    expect(result.currencyCode).toBe("USD");
    expect(result.keywords).toHaveLength(2);
    expect(result.missingKeywords).toEqual([]);
    expect(result.malformedKeywords).toBe(0);
    expect(result.duplicateKeywords).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.partial).toBe(false);
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
  });

  it("rejects keyword_metrics without keywords before any fetch", async () => {
    const error = await capture(
      provider.get({
        dataType: "keyword_metrics",
        locationCode: 2840,
        languageCode: "en",
        billingCustomer: {
          organizationId: "org-1",
          projectId: "proj-1",
          userId: "user-1",
          userEmail: "planner-test@example.com",
        },
      }),
    );
    expect(firstPartyMetaOf(error)?.errorClass).toBe("PROVIDER_UNSUPPORTED");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("isolates two connections behind the cache identity contract", async () => {
    const identityA: GoogleAdsPlannerCacheIdentity = {
      customer: "1111111111",
      loginCustomer: "3216549870",
      currencyCode: "USD",
      contract: "v26-planner",
    };
    connectionRepo.getByProjectId.mockResolvedValue({
      ...CONNECTION,
      customerId: "1111111111",
    });
    const { describePlannerCacheIdentity } =
      await import("./google-ads-planner-access");
    const identity = describePlannerCacheIdentity({
      ...CONNECTION,
      customerId: "1111111111",
    });
    expect(identity).toEqual(identityA);
    const other = describePlannerCacheIdentity(null);
    expect(other).toEqual({
      customer: null,
      loginCustomer: null,
      currencyCode: null,
      contract: identity.contract,
    });
  });

  it("keeps the customer resource header scope honest", async () => {
    fetchMock
      .mockResolvedValueOnce(geoSuggestResponse("US", "2840", "United States"))
      .mockResolvedValueOnce(languageConstantResponse())
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("running shoes")] }),
      );

    await provider.get(ideasRequest());

    expect(CUSTOMER_RESOURCE).toBe(`customers/${MANAGER_ID}`);
    expect(headersOf(callAt(fetchMock, 2).init)["login-customer-id"]).toBe(
      MANAGER_ID,
    );
  });
});
