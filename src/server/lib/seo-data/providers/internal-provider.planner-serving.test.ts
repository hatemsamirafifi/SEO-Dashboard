import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SEODataRequest } from "../types";

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn() },
  plannerRepo: {
    getLatestMetricsObservation:
      vi.fn<
        (input: {
          projectId: string;
          organizationId: string;
          locationCode: number;
          languageCode: string;
          minSourceFetchedAt?: string | null;
        }) => Promise<unknown>
      >(),
    getKeywordGroupMatches: vi.fn(),
  },
}));

vi.mock("@/db", () => ({ db: mocks.db }));

vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository",
  () => ({ GoogleAdsPlannerKeywordRepository: mocks.plannerRepo }),
);

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { createInternalProvider } from "./internal-provider";

const storedGroup = {
  record: {
    keyword: "alpha",
    closeVariants: ["alpha 2"],
    avgMonthlySearches: 81000,
    monthlySearchVolumes: [{ year: 2026, month: 5, volume: 74000 }],
    competition: "MEDIUM",
    competitionIndex: 52,
    averageCpcMicros: 1250000,
    lowTopOfPageBidMicros: 1500000,
    highTopOfPageBidMicros: 2500000,
  },
  sourceFetchedAt: "2026-10-20T00:00:00.000Z",
  currencyCode: "EUR",
};

const observation = {
  customerId: "1234567890",
  loginCustomerId: "9876543210",
  currencyCode: "EUR",
  sourceFetchedAt: "2026-10-20T00:00:00.000Z",
  truncated: false,
  partial: false,
  malformedKeywordCount: 0,
  duplicateKeywordCount: 0,
  missingKeywordCount: 0,
};

function makePlannerRequest(
  overrides: Partial<SEODataRequest> = {},
): SEODataRequest {
  return {
    dataType: "keyword_metrics",
    keywords: ["alpha"],
    locationCode: 2840,
    languageCode: "en",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
    billingCustomer: { organizationId: "org-1" } as never,
    constraints: { projectId: "project-1" },
    maxAgeSeconds: 86400,
    ...overrides,
  };
}

function fakeLegacySelect(rows: unknown[]) {
  mocks.db.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

/** The planner envelope shape the serving branch guarantees (an object with
 *  `keywords` and `missingKeywords`); verified structurally instead of
 *  asserting a blind cast onto the provider's `unknown` result. */
type PlannerEnvelopeProjection = {
  keywords: unknown;
  missingKeywords: unknown;
};

function isPlannerEnvelope(value: unknown): value is PlannerEnvelopeProjection {
  return (
    typeof value === "object" &&
    value !== null &&
    "keywords" in value &&
    "missingKeywords" in value
  );
}

function asPlannerEnvelope(value: unknown): PlannerEnvelopeProjection {
  if (!isPlannerEnvelope(value)) {
    throw new Error("unexpected planner serving payload shape");
  }
  return value;
}

describe("internal provider — first-party planner serving (keyword_metrics)", () => {
  const provider = createInternalProvider();

  beforeEach(() => vi.clearAllMocks());

  it("serves the stored planner envelope when a fresh observation exists", async () => {
    mocks.plannerRepo.getLatestMetricsObservation.mockResolvedValue(
      observation,
    );
    mocks.plannerRepo.getKeywordGroupMatches.mockResolvedValue({
      canonical: new Map([["alpha", storedGroup]]),
      variants: new Map([["alpha 2", storedGroup]]),
    });

    const result = await provider.get(makePlannerRequest());

    expect(result).toEqual({
      source: "google_ads",
      fetchedAt: "2026-10-20T00:00:00.000Z",
      currencyCode: "EUR",
      network: "GOOGLE_SEARCH_AND_PARTNERS",
      customerId: "1234567890",
      loginCustomerId: "9876543210",
      missingKeywords: [],
      malformedKeywords: 0,
      duplicateKeywords: 0,
      truncated: false,
      partial: false,
      ideas: [],
      keywords: [storedGroup.record],
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("resolves a variant keyword to its canonical group without duplicating records", async () => {
    mocks.plannerRepo.getLatestMetricsObservation.mockResolvedValue(
      observation,
    );
    mocks.plannerRepo.getKeywordGroupMatches.mockResolvedValue({
      canonical: new Map(),
      variants: new Map([["alpha 2", storedGroup]]),
    });

    const result = asPlannerEnvelope(
      await provider.get(makePlannerRequest({ keywords: ["alpha 2"] })),
    );

    expect(result.keywords).toEqual([storedGroup.record]);
    expect(result.missingKeywords).toEqual([]);
  });

  it("declares uncovered keywords as missingKeywords, never fabricated rows", async () => {
    mocks.plannerRepo.getLatestMetricsObservation.mockResolvedValue(
      observation,
    );
    mocks.plannerRepo.getKeywordGroupMatches.mockResolvedValue({
      canonical: new Map([["alpha", storedGroup]]),
      variants: new Map(),
    });

    const result = asPlannerEnvelope(
      await provider.get(makePlannerRequest({ keywords: ["alpha", "beta"] })),
    );

    expect(result.keywords).toEqual([storedGroup.record]);
    expect(result.missingKeywords).toEqual(["beta"]);
  });

  it("falls through to the legacy D1 read when the observation is stale or absent", async () => {
    mocks.plannerRepo.getLatestMetricsObservation.mockResolvedValue(null);
    fakeLegacySelect([{ keyword: "alpha", searchVolume: 10 }]);

    await expect(provider.get(makePlannerRequest())).resolves.toEqual([
      expect.objectContaining({ keyword: "alpha", searchVolume: 10 }),
    ]);
    expect(mocks.plannerRepo.getKeywordGroupMatches).not.toHaveBeenCalled();
  });

  it("never serves stored planner data on an always-fresh request", async () => {
    fakeLegacySelect([{ keyword: "alpha", searchVolume: 10 }]);

    await expect(
      provider.get(makePlannerRequest({ maxAgeSeconds: 0 })),
    ).resolves.toEqual([
      expect.objectContaining({ keyword: "alpha", searchVolume: 10 }),
    ]);
    expect(
      mocks.plannerRepo.getLatestMetricsObservation,
    ).not.toHaveBeenCalled();
  });

  it("scopes the observation read to the caller's freshness window", async () => {
    mocks.plannerRepo.getLatestMetricsObservation.mockResolvedValue(
      observation,
    );
    mocks.plannerRepo.getKeywordGroupMatches.mockResolvedValue({
      canonical: new Map([["alpha", storedGroup]]),
      variants: new Map(),
    });

    await provider.get(makePlannerRequest({ maxAgeSeconds: 3600 }));

    const lookup =
      mocks.plannerRepo.getLatestMetricsObservation.mock.calls[0]?.[0];
    expect(lookup).toBeDefined();
    expect(lookup?.projectId).toBe("project-1");
    expect(lookup?.organizationId).toBe("org-1");
    expect(lookup?.locationCode).toBe(2840);
    expect(lookup?.languageCode).toBe("en");
    expect(typeof lookup?.minSourceFetchedAt).toBe("string");
  });

  it("degrades to the legacy read when the planner layer fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.plannerRepo.getLatestMetricsObservation.mockRejectedValue(
      new Error("planner storage down"),
    );
    fakeLegacySelect([{ keyword: "alpha", searchVolume: 10 }]);

    await expect(provider.get(makePlannerRequest())).resolves.toEqual([
      expect.objectContaining({ keyword: "alpha", searchVolume: 10 }),
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
