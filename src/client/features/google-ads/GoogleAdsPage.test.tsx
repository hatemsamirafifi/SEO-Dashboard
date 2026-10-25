/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GoogleAdsOverviewSection } from "./GoogleAdsOverviewSection";
import { GoogleAdsBreakdownsSection } from "./GoogleAdsBreakdownsSection";
import { GoogleAdsStateBanner } from "./GoogleAdsStateViews";
import type { GoogleAdsAnalyticsOverview } from "./googleAdsTypes";
import type { GoogleAdsPageView } from "./googleAdsCopy";
import type {
  GoogleAdsCampaignBreakdown,
  GoogleAdsSearchTermBreakdown,
} from "./googleAdsTypes";

/** Pure render tests: the sections take plain props (no router, no query
 *  hooks, no server execution), so they render server-side. */

const kpiTotals = {
  impressions: 120,
  clicks: 10,
  cost: 5,
  conversions: 2,
  conversionsValue: 40,
  ctr: null,
  cpc: null,
  cpa: null,
  roas: null,
};

const overview: GoogleAdsAnalyticsOverview = {
  window: { startDate: "2026-09-18", endDate: "2026-10-15" },
  coverage: {
    status: "covered",
    coveredDates: 28,
    totalDates: 28,
    firstCoveredDate: "2026-09-18",
    lastCoveredDate: "2026-10-15",
  },
  totals: kpiTotals,
  rowCount: 3,
  daily: [
    {
      date: "2026-10-15",
      totals: { ...kpiTotals, conversions: 4, conversionsValue: 80 },
    },
  ],
  compare: {
    gate: "ready",
    window: { startDate: "2026-08-21", endDate: "2026-09-17" },
    deltas: [
      {
        metric: "cost",
        current: 6120.45,
        previous: 5810.6,
        absoluteChange: 309.85,
        pctChange: 5.33,
      },
    ],
  },
};

const campaigns: GoogleAdsCampaignBreakdown = {
  window: { startDate: "2026-09-18", endDate: "2026-10-15" },
  coverage: {
    status: "partial",
    coveredDates: 20,
    totalDates: 28,
    firstCoveredDate: "2026-09-18",
    lastCoveredDate: "2026-10-15",
  },
  metricDateBasis: "date",
  currencyCode: "USD",
  campaigns: [
    {
      campaignResourceId: "c1",
      campaignName: "Brand Search — US",
      campaignStatus: "ENABLED",
      campaignServingStatus: null,
      advertisingChannelType: "SEARCH",
      rowCount: 10,
      totals: kpiTotals,
    },
  ],
};

const searchTerms: GoogleAdsSearchTermBreakdown = {
  window: { startDate: "2026-09-18", endDate: "2026-10-15" },
  coverage: {
    status: "covered",
    coveredDates: 28,
    totalDates: 28,
    firstCoveredDate: "2026-09-18",
    lastCoveredDate: "2026-10-15",
  },
  metricDateBasis: "date",
  currencyCode: "USD",
  isPrivacyThresholdFiltered: true,
  searchTerms: [
    {
      campaignResourceId: "c1",
      adGroupResourceId: "a1",
      searchText: "buy running shoes online",
      keywordText: "buy running shoes online",
      keywordMatchType: "PHRASE",
      rowCount: 4,
      totals: kpiTotals,
    },
  ],
};

describe("GoogleAdsOverviewSection", () => {
  it("renders KPI values with currency and the equal-window delta", () => {
    const html = renderToStaticMarkup(
      <GoogleAdsOverviewSection overview={overview} currencyCode="USD" />,
    );
    expect(html).toContain("$5.00");
    expect(html).toContain("$40.00");
    expect(html).toContain("$5,810.60");
    expect(html).toContain("+$309.85");
    expect(html).toContain("+5.3%");
    expect(html).toContain("Complete");
    expect(html).toContain("28");
  });

  it("renders the compare-gate notice instead of deltas", () => {
    const gated = {
      ...overview,
      compare: {
        gate: "partial_coverage" as const,
        window: null,
        deltas: null,
      },
    };
    const html = renderToStaticMarkup(
      <GoogleAdsOverviewSection overview={gated} currencyCode="USD" />,
    );
    expect(html).toContain("Comparison unavailable");
    expect(html).not.toContain("vs");
  });

  it("renders missing totals as em dashes, never as zeros", () => {
    const empty = {
      ...overview,
      totals: {
        ...kpiTotals,
        impressions: null,
        clicks: null,
        cost: null,
        conversions: null,
        conversionsValue: null,
      },
      daily: [],
    };
    const html = renderToStaticMarkup(
      <GoogleAdsOverviewSection overview={empty} currencyCode="USD" />,
    );
    expect(html).toContain("\u2014");
  });
});

describe("GoogleAdsBreakdownsSection", () => {
  it("renders the campaign and search-term tables with their grains", () => {
    const html = renderToStaticMarkup(
      <GoogleAdsBreakdownsSection
        campaigns={campaigns}
        keywords={null}
        searchTerms={searchTerms}
        devices={null}
        landingPages={null}
        currencyCode="USD"
      />,
    );
    expect(html).toContain("Brand Search — US");
    expect(html).toContain("Partial coverage");
    expect(html).toContain("date basis: date");
    expect(html).toContain("buy running shoes online");
    expect(html).toContain("PHRASE");
  });

  it("always carries the search-term privacy floor notice", () => {
    const html = renderToStaticMarkup(
      <GoogleAdsBreakdownsSection
        campaigns={null}
        keywords={null}
        searchTerms={searchTerms}
        devices={null}
        landingPages={null}
        currencyCode="USD"
      />,
    );
    expect(html).toContain("floor, not a census");
  });

  it("renders no fabricated numbers when breakdowns are still loading", () => {
    const html = renderToStaticMarkup(
      <GoogleAdsBreakdownsSection
        campaigns={null}
        keywords={null}
        searchTerms={null}
        devices={null}
        landingPages={null}
        currencyCode="USD"
      />,
    );
    expect(html).not.toContain("$5.00");
    expect(html).toContain("Campaigns");
  });
});

describe("GoogleAdsStateBanner", () => {
  it("copies the distinct failure classes differently", () => {
    const quota: GoogleAdsPageView = {
      kind: "quota-failed",
      message: "quota gone",
    };
    expect(
      renderToStaticMarkup(<GoogleAdsStateBanner view={quota} />),
    ).toContain("quota");

    const perm: GoogleAdsPageView = {
      kind: "perm-failed",
      message: "no access",
    };
    expect(
      renderToStaticMarkup(<GoogleAdsStateBanner view={perm} />),
    ).toContain("Reconnect");

    const partial: GoogleAdsPageView = {
      kind: "partial",
      coveredThrough: "2026-10-10",
    };
    const partialHtml = renderToStaticMarkup(
      <GoogleAdsStateBanner view={partial} />,
    );
    expect(partialHtml).toContain("2026-10-10");
    expect(partialHtml).toContain("never zeroed");
  });

  it("renders nothing for the ok state", () => {
    const ok: GoogleAdsPageView = { kind: "ok" };
    expect(renderToStaticMarkup(<GoogleAdsStateBanner view={ok} />)).toBe("");
  });
});
