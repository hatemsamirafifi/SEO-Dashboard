import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("pure detector tests must not touch the database");
      },
    },
  ),
}));

import {
  DEFAULT_DETECTOR_THRESHOLDS as DETECTOR_THRESHOLDS,
  THRESHOLD_VERSION,
} from "@/shared/intelligence-thresholds";
import type { DetectorContext } from "./types";
import {
  detectPaidOrganicQueryGap,
  hasPaidSignal,
  isOrganicallyWeak,
  isPaidQueryGapInput,
  type PaidQueryGapInput,
} from "./paidOrganicQueryGap";

const CTX: DetectorContext = {
  projectId: "project-1",
  organizationId: "org-1",
  periodFrom: "2026-01-01",
  periodTo: "2026-01-28",
  thresholds: DETECTOR_THRESHOLDS.paid_organic_query_gap,
  thresholdVersion: THRESHOLD_VERSION,
};

const T = CTX.thresholds;

function input(overrides: Partial<PaidQueryGapInput> = {}): PaidQueryGapInput {
  return {
    periodFrom: CTX.periodFrom,
    periodTo: CTX.periodTo,
    currencyCode: "USD",
    metricDateBasis: "interaction_date",
    coverageRatio: 1,
    googleAdsUnitIds: ["1234567890:2026-01-28:search_term"],
    terms: [],
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minPaidCostMicros: 500_000,
      minPaidConversions: 1,
      minOrganicImpressions: 100,
      minOrganicPosition: 11,
    },
    ...overrides,
  };
}

describe("paid_organic_query_gap paid signal floors", () => {
  it("wins on the cost floor (micros, not currency)", () => {
    expect(
      hasPaidSignal(
        { paidCostMicros: 500_000, paidConversions: null },
        500_000,
        1,
      ),
    ).toBe(true);
    expect(
      hasPaidSignal(
        { paidCostMicros: 499_999, paidConversions: null },
        500_000,
        1,
      ),
    ).toBe(false);
    // Unknown cost (missing components) never counts as zero → no floor.
    expect(
      hasPaidSignal({ paidCostMicros: 0, paidConversions: null }, 500_000, 1),
    ).toBe(false);
  });

  it("wins on conversions even under the cost floor", () => {
    expect(
      hasPaidSignal({ paidCostMicros: 10, paidConversions: 1 }, 500_000, 1),
    ).toBe(true);
    expect(
      hasPaidSignal({ paidCostMicros: 10, paidConversions: 0 }, 500_000, 1),
    ).toBe(false);
  });
});

describe("paid_organic_query_gap organic weakness bands", () => {
  it("treats GSC absence as weak organic visibility", () => {
    expect(
      isOrganicallyWeak(
        {
          hasOrganicFacts: false,
          organicAvgPosition: null,
          organicImpressions: 0,
        },
        100,
        11,
      ),
    ).toBe(true);
  });

  it("flags striking-distance positions and impression floors", () => {
    expect(
      isOrganicallyWeak(
        {
          hasOrganicFacts: true,
          organicAvgPosition: 11,
          organicImpressions: 5000,
        },
        100,
        11,
      ),
    ).toBe(true);
    expect(
      isOrganicallyWeak(
        {
          hasOrganicFacts: true,
          organicAvgPosition: 10.9,
          organicImpressions: 99,
        },
        100,
        11,
      ),
    ).toBe(true);
  });

  it("keeps strong organic terms out", () => {
    expect(
      isOrganicallyWeak(
        {
          hasOrganicFacts: true,
          organicAvgPosition: 3.2,
          organicImpressions: 8000,
        },
        100,
        11,
      ),
    ).toBe(false);
  });
});

describe("paid_organic_query_gap detector", () => {
  it("emits per-term findings with distinct paid/organic fields", () => {
    const draft = input({
      terms: [
        {
          query: "erp software",
          paidCostMicros: 2_500_000,
          paidClicks: 80,
          paidConversions: null,
          organicClicks: 1,
          organicImpressions: 40,
          organicAvgPosition: 14.5,
          hasOrganicFacts: true,
        },
      ],
    });
    const drafts = detectPaidOrganicQueryGap(CTX, draft);
    expect(drafts).toHaveLength(1);
    const finding = drafts[0];
    expect(finding.entityKey).toBe("erp software");
    expect(finding.entity).toEqual({ query: "erp software" });
    expect(finding.evidence.sources).toEqual(["google_ads", "gsc"]);
    expect(finding.evidence.sourceRefs?.googleAdsUnitIds).toEqual([
      "1234567890:2026-01-28:search_term",
    ]);
    // Paid and organic live on distinct, non-derived fields.
    expect(finding.evidence.metrics).toMatchObject({
      paidCostMicros: 2_500_000,
      paidClicks: 80,
      organicImpressions: 40,
      organicClicks: 1,
      organicAvgPosition: 14.5,
      hasOrganicFacts: true,
    });
    // Unknown conversions surface as explicit unreported, not 0.
    expect(finding.evidence.metrics.paidConversionsUnreported).toBe(true);
    // Currency + metric-date basis are mirrored account/unit state.
    expect(finding.coverageFlags.currencyCode).toBe("USD");
    expect(finding.coverageFlags.metricDateBasis).toBe("interaction_date");
    expect(finding.confidenceScore).toBeGreaterThan(60);
    // No combined score keys, no causal field.
    const metricKeys = Object.keys(finding.evidence.metrics);
    expect(metricKeys.some((key) => /score/i.test(key))).toBe(false);
    expect(JSON.stringify(finding)).not.toMatch(/caused|rank_score|rankScore/);
  });

  it("reports unreported conversions with a positional weakness note", () => {
    const drafts = detectPaidOrganicQueryGap(
      CTX,
      input({
        terms: [
          {
            query: "crm pricing",
            paidCostMicros: 900_000,
            paidClicks: 30,
            paidConversions: null,
            organicClicks: 0,
            organicImpressions: 0,
            organicAvgPosition: null,
            hasOrganicFacts: false,
          },
        ],
      }),
    );
    expect(drafts[0].explanationFact).toContain("crm pricing");
    expect(drafts[0].explanationFact).toContain("no search-console facts");
    expect(drafts[0].explanationFact).toMatch(/^Paid search covered/);
  });

  it("validates typed input", () => {
    expect(isPaidQueryGapInput(input())).toBe(true);
    expect(isPaidQueryGapInput({})).toBe(false);
    expect(isPaidQueryGapInput(null)).toBe(false);
    expect(T.minPaidCostMicros).toBe(500_000);
    expect(T.minOrganicPosition).toBe(11);
  });
});
