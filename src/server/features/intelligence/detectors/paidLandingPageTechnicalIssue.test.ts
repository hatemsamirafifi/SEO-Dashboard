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
  detectPaidLandingPageTechnicalIssue,
  hasPaidVolume,
  isPaidLandingPageInput,
  type PaidLandingPageInput,
} from "./paidLandingPageTechnicalIssue";

const CTX: DetectorContext = {
  projectId: "project-1",
  organizationId: "org-1",
  periodFrom: "2026-01-01",
  periodTo: "2026-01-28",
  thresholds: DETECTOR_THRESHOLDS.paid_landing_page_technical_issue,
  thresholdVersion: THRESHOLD_VERSION,
};

function input(
  overrides: Partial<PaidLandingPageInput> = {},
): PaidLandingPageInput {
  return {
    periodFrom: CTX.periodFrom,
    periodTo: CTX.periodTo,
    auditId: "audit-1",
    currencyCode: "EUR",
    metricDateBasis: "interaction_date",
    coverageRatio: 1,
    googleAdsUnitIds: ["1234567890:2026-01-28:landing_page"],
    pages: [],
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minPaidCostMicros: 500_000,
      minPaidClicks: 25,
      severity: "critical",
      weakEngagementRate: 0.4,
    },
    ...overrides,
  };
}

describe("paid_landing_page_technical_issue paid volume floors", () => {
  it("accepts cost at the micros floor and clicks floor", () => {
    expect(
      hasPaidVolume(
        {
          costMicros: { total: 500_000, hasMissingComponents: false },
          clicks: { total: 5, hasMissingComponents: false },
        },
        500_000,
        25,
      ),
    ).toBe(true);
    expect(
      hasPaidVolume(
        {
          costMicros: { total: 499_999, hasMissingComponents: false },
          clicks: { total: 24, hasMissingComponents: false },
        },
        500_000,
        25,
      ),
    ).toBe(false);
  });

  it("never treats unknown totals as zero", () => {
    expect(
      hasPaidVolume(
        {
          costMicros: { total: null, hasMissingComponents: true },
          clicks: { total: 40, hasMissingComponents: false },
        },
        500_000,
        25,
      ),
    ).toBe(true);
    expect(
      hasPaidVolume(
        {
          costMicros: { total: null, hasMissingComponents: true },
          clicks: { total: null, hasMissingComponents: true },
        },
        500_000,
        25,
      ),
    ).toBe(false);
  });
});

describe("paid_landing_page_technical_issue detector", () => {
  it("keys findings per (canonical page, issue type) and refs audit issues", () => {
    const drafts = detectPaidLandingPageTechnicalIssue(
      CTX,
      input({
        pages: [
          {
            issueType: "missing_title",
            page: "https://example.com/pricing",
            paidCostMicros: 1_200_000,
            paidClicks: 60,
            auditIssuePresent: true,
            ga4EngagementRate: null,
            ga4Weak: false,
          },
        ],
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].entityKey).toBe(
      "technical:missing_title:https://example.com/pricing",
    );
    expect(drafts[0].entity).toMatchObject({
      issueType: "missing_title",
      page: "https://example.com/pricing",
      auditId: "audit-1",
    });
    expect(drafts[0].evidence.sources).toEqual(["google_ads", "audit"]);
    expect(drafts[0].evidence.sourceRefs).toEqual({
      googleAdsUnitIds: ["1234567890:2026-01-28:landing_page"],
      auditIssueIds: ["audit-1:missing_title"],
    });
    expect(drafts[0].evidence.metrics).toMatchObject({
      paidCostMicros: 1_200_000,
      paidClicks: 60,
    });
    // No combined score keys, no causal field.
    expect(
      Object.keys(drafts[0].evidence.metrics).some((key) => /score/i.test(key)),
    ).toBe(false);
    expect(JSON.stringify(drafts[0])).not.toMatch(
      /caused|rank_score|rankScore/,
    );
  });

  it("emits weak_engagement findings when GA4 shows a weak rate", () => {
    const drafts = detectPaidLandingPageTechnicalIssue(
      CTX,
      input({
        pages: [
          {
            issueType: "weak_engagement",
            page: "https://example.com/landing",
            paidCostMicros: 0,
            paidClicks: 55,
            auditIssuePresent: false,
            ga4EngagementRate: 0.31,
            ga4Weak: true,
          },
        ],
      }),
    );
    expect(drafts[0].entityKey).toBe(
      "technical:weak_engagement:https://example.com/landing",
    );
    expect(drafts[0].evidence.sources).toEqual(["google_ads"]);
    expect(drafts[0].evidence.metrics.ga4EngagementRate).toBeCloseTo(0.31, 4);
    expect(drafts[0].evidence.confidenceInputs.ga4WeakEngagement).toBe(true);
    expect(drafts[0].coverageFlags.metricDateBasis).toBe("interaction_date");
    expect(drafts[0].confidenceScore).toBe(68);
  });

  it("reports partial GA4 engagement coverage explicitly", () => {
    const drafts = detectPaidLandingPageTechnicalIssue(
      CTX,
      input({
        pages: [
          {
            issueType: "missing_meta_description",
            page: "https://example.com/guide",
            paidCostMicros: 800_000,
            paidClicks: 30,
            auditIssuePresent: true,
            ga4EngagementRate: null,
            ga4Weak: false,
          },
        ],
      }),
    );
    expect(drafts[0].evidence.partialData).toEqual([
      "ga4_engagement_unavailable",
    ]);
    expect(drafts[0].explanationFact).toContain("micros of spend");
  });

  it("validates typed input", () => {
    expect(isPaidLandingPageInput(input())).toBe(true);
    expect(isPaidLandingPageInput({})).toBe(false);
    expect(isPaidLandingPageInput(null)).toBe(false);
  });
});
