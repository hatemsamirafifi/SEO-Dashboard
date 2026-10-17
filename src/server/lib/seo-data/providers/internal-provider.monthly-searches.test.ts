// Stored monthly_searches shape contract for the internal provider
// (spec 014 task B). The keyword_metrics.monthly_searches column holds JSON
// TEXT; the provider must parse it into the normalized MonthlySearch[]
// contract. Malformed payloads are explicit ProviderUnavailableErrors (the
// router falls through to a fresh fetch) — never a downstream TypeError,
// never silent coercion to [].

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderUnavailableError } from "../errors";

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock("@/db", () => ({ db: mocks.db }));

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { createInternalProvider } from "./internal-provider";
import type { SEODataRequest } from "../types";

function fakeKeywordMetricsSelect(rows: unknown[]) {
  mocks.db.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

describe("internal provider — stored monthly_searches shape", () => {
  const provider = createInternalProvider();
  const request: SEODataRequest = {
    dataType: "keyword_metrics",
    keywords: ["one", "two"],
    locationCode: 2840,
    languageCode: "en",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
    billingCustomer: { organizationId: "org-1" } as never,
    constraints: { projectId: "project-1" },
  };

  beforeEach(() => vi.clearAllMocks());

  it("parses stored monthly_searches JSON into the normalized array contract", async () => {
    fakeKeywordMetricsSelect([
      {
        keyword: "one",
        searchVolume: 10,
        monthlySearches: JSON.stringify([
          { year: 2026, month: 1, search_volume: 10 },
        ]),
      },
      {
        keyword: "two",
        searchVolume: 20,
        monthlySearches: JSON.stringify([]),
      },
    ]);

    await expect(provider.get(request)).resolves.toEqual([
      expect.objectContaining({
        keyword: "one",
        monthlySearches: [{ year: 2026, month: 1, searchVolume: 10 }],
      }),
      expect.objectContaining({ keyword: "two", monthlySearches: [] }),
    ]);
  });

  it("maps an absent stored trend (NULL/empty column) to an empty array, not an error", async () => {
    fakeKeywordMetricsSelect([
      { keyword: "one", searchVolume: 10, monthlySearches: null },
      { keyword: "two", searchVolume: 20, monthlySearches: "" },
    ]);

    await expect(provider.get(request)).resolves.toEqual([
      expect.objectContaining({ keyword: "one", monthlySearches: [] }),
      expect.objectContaining({ keyword: "two", monthlySearches: [] }),
    ]);
  });

  it("rejects corrupt stored monthly_searches JSON as unavailable (never a crash, never coerced)", async () => {
    fakeKeywordMetricsSelect([
      {
        keyword: "one",
        searchVolume: 10,
        monthlySearches: "{not valid json",
      },
      { keyword: "two", searchVolume: 20, monthlySearches: "[]" },
    ]);

    const error: unknown = await provider.get(request).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toMatchObject({
      message:
        'Stored keyword_metrics monthly_searches is not valid JSON for keyword "one"',
    });
  });

  it("rejects stored monthly_searches that parses to a non-array (the .map crash shape)", async () => {
    // A bare JSON string in the column is exactly what crashed
    // toMcpKeywordMetricRow with "row.monthlySearches.map is not a function".
    for (const malformed of ['"[{\\"year\\":2026}]"', "42", "{}"]) {
      fakeKeywordMetricsSelect([
        { keyword: "one", searchVolume: 10, monthlySearches: malformed },
        { keyword: "two", searchVolume: 20, monthlySearches: "[]" },
      ]);

      await expect(provider.get(request)).rejects.toThrow(
        'Stored keyword_metrics monthly_searches is not an array for keyword "one"',
      );
    }
  });
});
