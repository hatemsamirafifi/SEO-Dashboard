import { describe, expect, it } from "vitest";

import type { GoogleAdsKeywordRecord } from "@/server/lib/googleAdsPlanner";
import {
  mapGoogleMetricRecords,
  mapGoogleResearchRecords,
} from "./google-records";

/** A planner record row exactly as the google_ads provider payload exposes
 *  it (GoogleAdsKeywordRecord from the v26 typed client). Micros and the
 *  0-100 competition index are still Google-native here; conversion belongs
 *  to the mapper so provider payloads stay raw. */
function record(
  overrides: Record<string, unknown> = {},
): GoogleAdsKeywordRecord {
  return {
    keyword: "running shoes",
    closeVariants: [],
    avgMonthlySearches: 81000,
    monthlySearchVolumes: [
      { year: 2026, month: 9, volume: 74000 },
      { year: 2026, month: 10, volume: 91000 },
    ],
    competition: "MEDIUM",
    competitionIndex: 52,
    averageCpcMicros: 1250000,
    lowTopOfPageBidMicros: 880000,
    highTopOfPageBidMicros: 2400000,
    ...overrides,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion — fixtures intentionally include malformed rows the mapper must skip
  } as GoogleAdsKeywordRecord;
}

describe("mapGoogleResearchRecords", () => {
  it("maps a planner record into a research row without KD or intent", () => {
    // toMatchObject (not toEqual): key PRESENCE of the additive bid/
    // competition fields is pinned by the next two tests, and toEqual would
    // reject the additive keys this mapper intentionally carries.
    const [row] = mapGoogleResearchRecords([record()]);

    expect(row).toMatchObject({
      keyword: "running shoes",
      searchVolume: 81000,
      trend: [
        { year: 2026, month: 9, searchVolume: 74000 },
        { year: 2026, month: 10, searchVolume: 91000 },
      ],
      cpc: 1.25,
      competition: 0.52,
      keywordDifficulty: null,
      intent: "unknown",
    });
  });

  it("exposes bid and competition metadata additively when present", () => {
    expect(mapGoogleResearchRecords([record()])[0]).toMatchObject({
      lowTopOfPageBid: 0.88,
      highTopOfPageBid: 2.4,
      competitionLevel: "MEDIUM",
    });
  });

  it("drops monthly rows without a volume instead of coercing null to 0", () => {
    const [row] = mapGoogleResearchRecords([
      record({
        monthlySearchVolumes: [{ year: 2026, month: 10, volume: null }],
      }),
    ]);

    expect(row.trend).toEqual([]);
  });

  it("keeps honest nulls when the planner returned no metrics", () => {
    const [row] = mapGoogleResearchRecords([
      record({ avgMonthlySearches: null }),
    ]);

    expect(row.searchVolume).toBeNull();
    expect(row.cpc).toBeNull();
    expect(row.competition).toBeNull();
    expect(row).not.toHaveProperty("lowTopOfPageBid");
    expect(row).not.toHaveProperty("highTopOfPageBid");
  });

  it("normalizes case variants and skips rows without a keyword", () => {
    const rows = mapGoogleResearchRecords([
      record({ keyword: "Running Shoes" }),
      record({ keyword: "" }),
      record({ keyword: undefined }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].keyword).toBe("running shoes");
  });

  it("maps close variants as additional canonical rows, deduped", () => {
    const rows = mapGoogleResearchRecords([
      record({
        keyword: "runing shoe",
        closeVariants: ["running shoes", "Runing Shoe"],
      }),
    ]);

    expect(
      rows.map((row) => row.keyword).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["runing shoe", "running shoes"]);
  });
});

describe("mapGoogleMetricRecords", () => {
  it("produces KeywordMetricRow-shaped rows from planner records", () => {
    const rows = mapGoogleMetricRecords([record()]);

    expect(rows).toEqual([
      {
        keyword: "running shoes",
        searchVolume: 81000,
        cpc: 1.25,
        competition: 0.52,
        competitionLevel: "MEDIUM",
        keywordDifficulty: null,
        intent: "unknown",
        monthlySearches: [
          { year: 2026, month: 9, searchVolume: 74000 },
          { year: 2026, month: 10, searchVolume: 91000 },
        ],
      },
    ]);
  });

  it("normalizes non-competition levels to null", () => {
    const rows = mapGoogleMetricRecords([
      record({ competition: "UNSPECIFIED" }),
    ]);

    expect(rows[0].competitionLevel).toBeNull();
  });
});
