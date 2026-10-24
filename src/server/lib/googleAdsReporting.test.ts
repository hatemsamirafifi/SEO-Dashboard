/* eslint-disable max-lines */
import { describe, expect, it, vi } from "vitest";

import {
  GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS,
  buildGoogleAdsDailyAccountQuery,
  buildGoogleAdsDailyAdGroupQuery,
  buildGoogleAdsDailyCampaignQuery,
  buildGoogleAdsDailyKeywordQuery,
  buildGoogleAdsDailyLandingPageQuery,
  buildGoogleAdsDailySearchTermQuery,
  buildGoogleAdsDailyDeviceQuery,
  buildGoogleAdsDailyWindowClause,
  validateGoogleAdsDailyFactsWindow,
} from "./googleAdsReporting";
import {
  extractGoogleAdsDailyAccountRow,
  extractGoogleAdsDailyAdGroupRow,
  extractGoogleAdsDailyCampaignRow,
  extractGoogleAdsDailyKeywordRow,
  extractGoogleAdsDailyLandingPageRow,
  extractGoogleAdsDailySearchTermRow,
  extractGoogleAdsDailyDeviceRow,
  parseGoogleAdsDailyPage,
} from "./googleAdsReporting.parsers";
import type { GoogleAdsDailyFactsInput } from "./googleAdsReporting";

const OK_START = "2026-09-01";
const OK_END = "2026-09-30";
const INPUT: GoogleAdsDailyFactsInput = {
  customerId: "4897513260",
  startDate: OK_START,
  endDate: OK_END,
};

describe("daily report window validation", () => {
  it("accepts an inclusive single day and equal dates", () => {
    expect(
      validateGoogleAdsDailyFactsWindow({
        customerId: "4897513260",
        startDate: OK_END,
        endDate: OK_END,
      }),
    ).toMatchObject({ ok: true });
  });

  it("accepts a window at the supported 37-month history maximum", () => {
    expect(
      validateGoogleAdsDailyFactsWindow({
        customerId: "4897513260",
        startDate: "2023-09-30",
        endDate: OK_END,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a window beyond the supported granular history maximum", () => {
    expect(
      validateGoogleAdsDailyFactsWindow({
        customerId: "4897513260",
        startDate: "2023-09-01",
        endDate: OK_END,
      }).ok,
    ).toBe(false);
  });

  it("rejects reversed, future and malformed windows", () => {
    const reversed = validateGoogleAdsDailyFactsWindow({
      customerId: "4897513260",
      startDate: OK_END,
      endDate: OK_START,
    });
    const badCalendar = validateGoogleAdsDailyFactsWindow({
      customerId: "4897513260",
      startDate: "2026-02-30",
      endDate: OK_END,
    });
    const badFormat = validateGoogleAdsDailyFactsWindow({
      customerId: "4897513260",
      startDate: "2026-9-1",
      endDate: OK_END,
    });
    expect(reversed.ok).toBe(false);
    expect(badCalendar.ok).toBe(false);
    expect(badFormat.ok).toBe(false);
    vi.useFakeTimers({ now: new Date("2026-10-24T12:00:00.000Z") });
    try {
      const future = validateGoogleAdsDailyFactsWindow({
        customerId: "4897513260",
        startDate: OK_START,
        endDate: "2026-10-27",
      });
      expect(future.ok).toBe(false);
      // Tomorrow may still be the account's local "today" under a large
      // UTC offset, so today+1 stays acceptable.
      const edge = validateGoogleAdsDailyFactsWindow({
        customerId: "4897513260",
        startDate: OK_START,
        endDate: "2026-10-25",
      });
      expect(edge.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed customer ids and invalid login ids before any fetch", () => {
    const badCustomer = validateGoogleAdsDailyFactsWindow({
      customerId: "123",
      startDate: OK_START,
      endDate: OK_END,
    });
    const badLogin = validateGoogleAdsDailyFactsWindow({
      ...INPUT,
      loginCustomerId: "123",
    });
    expect(badCustomer.ok).toBe(false);
    expect(badLogin.ok).toBe(false);
    const validLogin = validateGoogleAdsDailyFactsWindow({
      ...INPUT,
      loginCustomerId: "3216549870",
    });
    expect(validLogin).toMatchObject({ ok: true });
  });
});

describe("fixed daily report queries", () => {
  const CASES = [
    {
      name: "account",
      build: buildGoogleAdsDailyAccountQuery,
      from: "FROM customer",
      fields: [
        "customer.resource_name",
        "customer.descriptive_name",
        "customer.currency_code",
        "customer.time_zone",
      ],
    },
    {
      name: "campaign",
      build: buildGoogleAdsDailyCampaignQuery,
      from: "FROM campaign",
      fields: [
        "campaign.resource_name",
        "campaign.name",
        "campaign.status",
        "campaign.serving_status",
        "campaign.advertising_channel_type",
      ],
    },
    {
      name: "ad_group",
      build: buildGoogleAdsDailyAdGroupQuery,
      from: "FROM ad_group",
      fields: [
        "ad_group.resource_name",
        "ad_group.name",
        "ad_group.status",
        "campaign.resource_name",
      ],
    },
    {
      name: "keyword",
      build: buildGoogleAdsDailyKeywordQuery,
      from: "FROM keyword_view",
      fields: [
        "ad_group_criterion.resource_name",
        "ad_group_criterion.criterion_id",
        "ad_group_criterion.keyword.text",
        "ad_group_criterion.keyword.match_type",
        "ad_group.resource_name",
        "campaign.resource_name",
      ],
    },
    {
      name: "search_term",
      build: buildGoogleAdsDailySearchTermQuery,
      from: "FROM search_term_view",
      fields: [
        "search_term_view.resource_name",
        "search_term_view.search_term",
        "ad_group.resource_name",
        "campaign.resource_name",
      ],
    },
    {
      name: "device",
      build: buildGoogleAdsDailyDeviceQuery,
      from: "FROM campaign",
      fields: ["campaign.resource_name", "segments.device"],
    },
    {
      name: "landing_page",
      build: buildGoogleAdsDailyLandingPageQuery,
      from: "FROM landing_page_view",
      fields: [
        "landing_page_view.resource_name",
        "landing_page_view.unexpanded_final_url",
        "campaign.resource_name",
      ],
    },
  ] as const;

  it.each(CASES)(
    "$name selects only official v26 fields from its documented resource",
    ({ build, from, fields }) => {
      const built = build(INPUT);
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("expected a valid query");
      expect(built.value).toContain(from);
      for (const field of fields) expect(built.value).toContain(field);
      // The shared daily metric block plus segments.date.
      for (const metric of [
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "segments.date",
      ]) {
        expect(built.value).toContain(metric);
      }
      expect(built.value).toContain(
        `WHERE segments.date BETWEEN '${OK_START}' AND '${OK_END}'`,
      );
    },
  );

  it("filters keyword-view rows to advertising keyword criteria", () => {
    const built = buildGoogleAdsDailyKeywordQuery(INPUT);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("expected a valid query");
    expect(built.value).toContain("ad_group_criterion.type = KEYWORD");
  });

  it("builds the fixed window clause and parses ad group rows with chain identity", () => {
    expect(GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS).toBe(37);
    expect(buildGoogleAdsDailyWindowClause("2026-09-01", "2026-09-30")).toBe(
      `WHERE segments.date BETWEEN '${OK_START}' AND '${OK_END}'`,
    );
    const parsed = extractGoogleAdsDailyAdGroupRow({
      adGroup: {
        resourceName: "customers/4897513260/adGroups/13867998706",
        id: "13867998706",
        name: "Mountain bikes",
        status: "ENABLED",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
      metrics: { impressions: "5", costMicros: "12000000" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value).toMatchObject({
      date: OK_START,
      adGroupResourceId: "customers/4897513260/adGroups/13867998706",
      adGroupId: "13867998706",
      adGroupName: "Mountain bikes",
      adGroupStatus: "ENABLED",
      campaignResourceId: "customers/4897513260/campaigns/18835700179",
      metrics: { impressions: 5, costMicros: 12000000 },
    });
    const missingChain = extractGoogleAdsDailyAdGroupRow({
      adGroup: {
        resourceName: "customers/4897513260/adGroups/13867998706",
      },
      segments: { date: OK_START },
    });
    expect(missingChain.ok).toBe(false);
  });
});

describe("daily row parsers (ProtoJSON REST rows)", () => {
  it("parses a realistic account day with campaign-free identity metadata", () => {
    const row = {
      customer: {
        resourceName: "customers/4897513260",
        id: "4897513260",
        descriptiveName: "Nordic store",
        currencyCode: "SEK",
        timeZone: "Europe/Stockholm",
      },
      segments: { date: "2026-09-01" },
      metrics: {
        impressions: "20342",
        clicks: "14276",
        costMicros: "2500000",
        conversions: 2.5,
        conversionsValue: 50,
      },
    };
    const parsed = extractGoogleAdsDailyAccountRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value).toMatchObject({
      resourceName: "customers/4897513260",
      displayName: "Nordic store",
      currencyCode: "SEK",
      timeZone: "Europe/Stockholm",
      date: "2026-09-01",
      metrics: {
        impressions: 20342,
        clicks: 14276,
        costMicros: 2500000,
        conversions: 2.5,
        conversionsValue: 50,
      },
    });
  });

  it("keeps true zero days and numbers fractional conversions from strings", () => {
    const row = {
      customer: { resourceName: "customers/4897513260" },
      segments: { date: "2026-09-02" },
      metrics: {
        impressions: 0,
        clicks: "0",
        costMicros: "0",
        conversions: "2.5",
        conversionsValue: 0,
      },
    };
    const parsed = extractGoogleAdsDailyAccountRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value.metrics).toEqual({
      impressions: 0,
      clicks: 0,
      costMicros: 0,
      conversions: 2.5,
      conversionsValue: 0,
    });
  });

  it("retains overlarge int64 cost micros as digits text instead of a lossy float", () => {
    const row = {
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
        id: "18835700179",
        name: "Great Stature - Search",
        status: "ENABLED",
      },
      segments: { date: OK_START },
      metrics: {
        impressions: "422829710",
        clicks: "4228297",
        costMicros: "99999999999999999999",
      },
    };
    const parsed = extractGoogleAdsDailyCampaignRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value.metrics.costMicros).toBe("99999999999999999999");
    expect(parsed.value.metrics.impressions).toBe(422829710);
  });

  it("rejects campaign rows missing resource identity or a real segment date", () => {
    const missingCampaign = extractGoogleAdsDailyCampaignRow({
      segments: { date: OK_START },
    });
    const badDate = extractGoogleAdsDailyCampaignRow({
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
        id: "18835700179",
        name: "x",
        status: "ENABLED",
      },
      segments: { date: "2026-02-30" },
    });
    expect(missingCampaign.ok).toBe(false);
    expect(badDate.ok).toBe(false);
  });

  it("requires the ad group chain identity on keyword rows and keeps criterion identity", () => {
    const row = {
      adGroupCriterion: {
        resourceName: "customers/4897513260/adGroupCriteria/1123456789",
        criterionId: "1123456789",
        keyword: { text: "mountain bike red", matchType: "EXACT" },
      },
      adGroup: {
        resourceName: "customers/4897513260/adGroups/13867998706",
        id: "13867998706",
        name: "Mountain bikes",
        status: "ENABLED",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
      metrics: { impressions: "12" },
    };
    const parsed = extractGoogleAdsDailyKeywordRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value).toMatchObject({
      keywordResourceId: "customers/4897513260/adGroupCriteria/1123456789",
      criterionId: "1123456789",
      keywordText: "mountain bike red",
      keywordMatchType: "EXACT",
      adGroupResourceId: "customers/4897513260/adGroups/13867998706",
      campaignResourceId: "customers/4897513260/campaigns/18835700179",
      metrics: { impressions: 12, costMicros: null },
    });
    const missingChain = extractGoogleAdsDailyKeywordRow({
      adGroupCriterion: {
        resourceName: "customers/4897513260/adGroupCriteria/1123456789",
        criterionId: "1123456789",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
    });
    expect(missingChain.ok).toBe(false);
  });

  it("parses search term rows into the implicit ad-group grain with kept term text", () => {
    const row = {
      searchTermView: {
        resourceName:
          "customers/4897513260/searchTermViews/MTAuMjY0LmNlNTUuMzUz",
        searchTerm: "mountain bike store",
        status: "SERVING",
      },
      adGroup: {
        resourceName: "customers/4897513260/adGroups/13867998706",
        id: "13867998706",
        name: "Mountain bikes",
        status: "ENABLED",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
      metrics: { impressions: "7" },
    };
    const parsed = extractGoogleAdsDailySearchTermRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value).toMatchObject({
      campaignResourceId: "customers/4897513260/campaigns/18835700179",
      adGroupResourceId: "customers/4897513260/adGroups/13867998706",
      searchText: "mountain bike store",
      keywordText: null,
      keywordMatchType: null,
      metrics: { impressions: 7 },
    });
    // The v26 search_term_view has no keyword/match-type fields: matched
    // keyword attributes stay null, never guessed.
    const sameTermOtherAdGroup = extractGoogleAdsDailySearchTermRow({
      searchTermView: {
        resourceName: "customers/4897513260/searchTermViews/UVJWI",
        searchTerm: "mountain bike store",
      },
      adGroup: {
        resourceName: "customers/4897513260/adGroups/13867998707",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
    });
    expect(sameTermOtherAdGroup.ok).toBe(true);
    if (!sameTermOtherAdGroup.ok) throw new Error("expected a parsed row");
    expect(sameTermOtherAdGroup.value.adGroupResourceId).toBe(
      "customers/4897513260/adGroups/13867998707",
    );
    const emptyTerm = extractGoogleAdsDailySearchTermRow({
      searchTermView: {
        resourceName: "customers/4897513260/searchTermViews/XY",
      },
      adGroup: {
        resourceName: "customers/4897513260/adGroups/13867998706",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
    });
    expect(emptyTerm.ok).toBe(false);
  });

  it("requires device rows to carry campaign identity and a known device", () => {
    const row = {
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
        id: "18835700179",
        name: "Great Stature - Search",
        status: "ENABLED",
      },
      segments: { date: OK_START, device: "DESKTOP" },
      metrics: { impressions: "12" },
    };
    const parsed = extractGoogleAdsDailyDeviceRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value.device).toBe("DESKTOP");
    const unknownDevice = extractGoogleAdsDailyDeviceRow({
      campaign: row.campaign,
      segments: { date: OK_START, device: "HOLOGRAM" },
    });
    expect(unknownDevice.ok).toBe(false);
    const missingCampaign = extractGoogleAdsDailyDeviceRow({
      segments: { date: OK_START, device: "DESKTOP" },
    });
    expect(missingCampaign.ok).toBe(false);
  });

  it("preserves the full unexpanded landing page URL with campaign identity", () => {
    const url =
      "https://www.example.com/backpacks?gclid=CPtWsq-bnmsXCFZtoQodEcgBRg";
    const row = {
      landingPageView: {
        resourceName: "customers/4897513260/landingPageViews/cZepkXtkq",
        unexpandedFinalUrl: url,
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
      metrics: { impressions: "3" },
    };
    const parsed = extractGoogleAdsDailyLandingPageRow(row);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a parsed row");
    expect(parsed.value.landingPageUrl).toBe(url);
    expect(parsed.value.landingPageResourceId).toBe(
      "customers/4897513260/landingPageViews/cZepkXtkq",
    );
    const strippedCampaign = extractGoogleAdsDailyLandingPageRow({
      landingPageView: {
        resourceName: "customers/4897513260/landingPageViews/cZepkXtkq",
        unexpandedFinalUrl: url,
      },
      segments: { date: OK_START },
    });
    expect(strippedCampaign.ok).toBe(false);
  });

  it("parses pages with omitted and null repeated results as empty successes", () => {
    const empty = parseGoogleAdsDailyPage({}, extractGoogleAdsDailyAccountRow);
    expect(empty.ok).toBe(true);
    const nulled = parseGoogleAdsDailyPage(
      { results: null },
      extractGoogleAdsDailyAccountRow,
    );
    expect(nulled.ok).toBe(true);
  });

  it("rejects a non-array repeated results field as a malformed page", () => {
    const bad = parseGoogleAdsDailyPage(
      { results: "not-a-list" },
      extractGoogleAdsDailyAccountRow,
    );
    expect(bad.ok).toBe(false);
  });

  it("counts malformed rows and reports a partial page instead of dropping them", () => {
    const valid = {
      landingPageView: {
        resourceName: "customers/4897513260/landingPageViews/cZepkXtkq",
        unexpandedFinalUrl: "https://www.example.com/backpacks",
      },
      campaign: {
        resourceName: "customers/4897513260/campaigns/18835700179",
      },
      segments: { date: OK_START },
      metrics: { impressions: "3" },
    };
    const page = parseGoogleAdsDailyPage(
      { results: [valid, { landingPageView: {} }], nextPageToken: "tok-2" },
      extractGoogleAdsDailyLandingPageRow,
    );
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("expected a parsed page");
    expect(page.value).toMatchObject({
      rows: [
        {
          date: OK_START,
          campaignResourceId: "customers/4897513260/campaigns/18835700179",
          landingPageResourceId:
            "customers/4897513260/landingPageViews/cZepkXtkq",
          landingPageUrl: "https://www.example.com/backpacks",
          metrics: { impressions: 3 },
        },
      ],
      malformedRows: 1,
      nextPageToken: "tok-2",
    });
  });
});
