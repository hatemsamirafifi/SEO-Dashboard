/* eslint-disable max-lines */
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import { z } from "zod";

const getAccessToken = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getAccessToken } }) }));

import {
  GoogleAdsMalformedResponseError,
  classifyGoogleAdsError,
  createGoogleAdsClient,
} from "./googleAdsClient";
import type {
  GoogleAdsDailyFactsInput,
  GoogleAdsDailyFactsResult,
  GoogleAdsDailyCampaignRow,
  GoogleAdsDailyDeviceRow,
  GoogleAdsDailyLandingPageRow,
  GoogleAdsDailySearchTermRow,
} from "./googleAdsReporting";

type AdsClient = ReturnType<typeof createGoogleAdsClient>;
type DailyInput = GoogleAdsDailyFactsInput;

const CUSTOMER_ID = "4897513260";
const MANAGER_ID = "3216549870";
const BASE = "https://googleads.googleapis.com/v26";
const WINDOW: DailyInput = {
  customerId: CUSTOMER_ID,
  loginCustomerId: MANAGER_ID,
  startDate: "2026-09-01",
  endDate: "2026-09-30",
};

let fetchMock: MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function searchResponse(results: unknown[], nextPageToken?: string) {
  return jsonResponse({ results, ...(nextPageToken ? { nextPageToken } : {}) });
}

/** Canonical Google JSON error body (googleads.googleapis.com). */
function adsErrorResponse(status: number, errorCode?: Record<string, string>) {
  return jsonResponse(
    {
      error: {
        code: status,
        message: "Raw upstream message that must never leak: SECRET-VALUE",
        details: [
          {
            errors: [
              { errorCode, message: "Raw ads failure that must never leak" },
            ],
            requestId: "pipeline-yb7mCEUYxcIgkD3xAIdrjQ",
          },
        ],
      },
    },
    status,
  );
}

const CAMPAIGN = {
  resourceName: "customers/4897513260/campaigns/18835700179",
  id: "18835700179",
  name: "Great Stature - Search",
  status: "ENABLED",
};
const AD_GROUP = {
  resourceName: "customers/4897513260/adGroups/13867998706",
  id: "13867998706",
  name: "Mountain bikes",
  status: "ENABLED",
};
const METRICS = {
  impressions: "20342",
  clicks: "14276",
  costMicros: "2500000",
  conversions: 2.5,
  conversionsValue: 50,
};

/** Realistic v26 REST rows per grain (lowerCamelCase nested resources). */
const ROWS = {
  account: {
    customer: {
      resourceName: "customers/4897513260",
      id: "4897513260",
      descriptiveName: "Nordic store",
      currencyCode: "SEK",
      timeZone: "Europe/Stockholm",
    },
    segments: { date: "2026-09-01" },
    metrics: METRICS,
  },
  campaign: {
    campaign: CAMPAIGN,
    segments: { date: "2026-09-01" },
    metrics: METRICS,
  },
  ad_group: {
    adGroup: AD_GROUP,
    campaign: { resourceName: CAMPAIGN.resourceName },
    segments: { date: "2026-09-01" },
    metrics: METRICS,
  },
  keyword: {
    adGroupCriterion: {
      resourceName: "customers/4897513260/adGroupCriteria/1123456789",
      criterionId: "1123456789",
      keyword: { text: "mountain bike red", matchType: "EXACT" },
    },
    adGroup: AD_GROUP,
    campaign: { resourceName: CAMPAIGN.resourceName },
    segments: { date: "2026-09-01" },
    metrics: METRICS,
  },
  search_term: {
    searchTermView: {
      resourceName: "customers/4897513260/searchTermViews/MTAuY2U1NS4zNTM",
      searchTerm: "mountain bike store",
      status: "SERVING",
    },
    adGroup: AD_GROUP,
    campaign: { resourceName: CAMPAIGN.resourceName },
    segments: { date: "2026-09-01" },
    metrics: METRICS,
  },
  device: {
    campaign: CAMPAIGN,
    segments: { date: "2026-09-01", device: "DESKTOP" },
    metrics: METRICS,
  },
  landing_page: {
    landingPageView: {
      resourceName: "customers/4897513260/landingPageViews/cZepkXtkq",
      unexpandedFinalUrl:
        "https://www.example.com/backpacks?gclid=CPtWsq-bnmsXCFZtoQodEcgBRg",
    },
    campaign: { resourceName: CAMPAIGN.resourceName },
    segments: { date: "2026-09-01" },
    metrics: METRICS,
  },
} as const;

const DAILY_METHODS = [
  "getDailyAccountFacts",
  "getDailyCampaignFacts",
  "getDailyAdGroupFacts",
  "getDailyKeywordFacts",
  "getDailySearchTermFacts",
  "getDailyDeviceFacts",
  "getDailyLandingPageFacts",
] as const;

const CASES: Array<{
  grain: string;
  from: string;
  row: unknown;
  expectRow: Record<string, unknown>;
  call: (
    client: AdsClient,
    input: DailyInput,
  ) => Promise<GoogleAdsDailyFactsResult<unknown>>;
}> = [
  {
    grain: "account",
    from: "FROM customer",
    row: ROWS.account,
    expectRow: {
      resourceName: "customers/4897513260",
      currencyCode: "SEK",
      timeZone: "Europe/Stockholm",
    },
    call: (client, input) => client.getDailyAccountFacts(input),
  },
  {
    grain: "campaign",
    from: "FROM campaign",
    row: ROWS.campaign,
    expectRow: {
      campaignResourceId: CAMPAIGN.resourceName,
      campaignName: "Great Stature - Search",
      campaignStatus: "ENABLED",
    },
    call: (client, input) => client.getDailyCampaignFacts(input),
  },
  {
    grain: "ad_group",
    from: "FROM ad_group",
    row: ROWS.ad_group,
    expectRow: {
      adGroupResourceId: AD_GROUP.resourceName,
      adGroupName: "Mountain bikes",
      campaignResourceId: CAMPAIGN.resourceName,
    },
    call: (client, input) => client.getDailyAdGroupFacts(input),
  },
  {
    grain: "keyword",
    from: "FROM keyword_view",
    row: ROWS.keyword,
    expectRow: {
      keywordResourceId: "customers/4897513260/adGroupCriteria/1123456789",
      criterionId: "1123456789",
      keywordText: "mountain bike red",
      keywordMatchType: "EXACT",
      adGroupResourceId: AD_GROUP.resourceName,
      campaignResourceId: CAMPAIGN.resourceName,
    },
    call: (client, input) => client.getDailyKeywordFacts(input),
  },
  {
    grain: "search_term",
    from: "FROM search_term_view",
    row: ROWS.search_term,
    expectRow: {
      searchText: "mountain bike store",
      keywordText: null,
      keywordMatchType: null,
      adGroupResourceId: AD_GROUP.resourceName,
      campaignResourceId: CAMPAIGN.resourceName,
    },
    call: (client, input) => client.getDailySearchTermFacts(input),
  },
  {
    grain: "device",
    from: "FROM campaign",
    row: ROWS.device,
    expectRow: {
      device: "DESKTOP",
      campaignResourceId: CAMPAIGN.resourceName,
    },
    call: (client, input) => client.getDailyDeviceFacts(input),
  },
  {
    grain: "landing_page",
    from: "FROM landing_page_view",
    row: ROWS.landing_page,
    expectRow: {
      landingPageResourceId: "customers/4897513260/landingPageViews/cZepkXtkq",
      campaignResourceId: CAMPAIGN.resourceName,
    },
    call: (client, input) => client.getDailyLandingPageFacts(input),
  },
];

const client = () =>
  createGoogleAdsClient({ userId: "user-1", grantAccountId: "google-1" });

/** Typed view of a recorded fetch call. */
function callAt(index: number): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  const [input, init] = call;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return { url, init };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function bodyRecord(init: RequestInit | undefined): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") throw new Error("expected a JSON request body");
  const parsed: unknown = JSON.parse(raw);
  return z.record(z.string(), z.unknown()).parse(parsed);
}

async function capture(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => Promise.reject(new Error("expected the call to reject")),
    (error: unknown) => error,
  );
}

describe("Google Ads v26 daily reporting client", () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn());
    fetchMock = vi.mocked(fetch);
  });

  it("exposes only the fixed daily reporting reads (no arbitrary GAQL, mutate or raw Search)", () => {
    const ads = client();
    const keys = Object.keys(ads);
    const dailyMethods = keys.filter((key) => key.startsWith("getDaily"));
    expect(dailyMethods.toSorted()).toEqual([...DAILY_METHODS].toSorted());
    for (const forbidden of [
      "search",
      "query",
      "rawSearch",
      "searchStream",
      "mutate",
      "report",
      "listAccessibleQuery",
    ]) {
      expect(keys).not.toContain(forbidden);
      expect(ads).not.toHaveProperty(forbidden);
    }
  });

  it.each(CASES)(
    "fetches $grain days with the fixed query, manager login and NO pageSize",
    async ({ grain, from, row, expectRow, call }) => {
      fetchMock.mockResolvedValueOnce(searchResponse([row]));
      const result = await call(client(), WINDOW);
      expect(result).toMatchObject({
        grain,
        customerId: CUSTOMER_ID,
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        metricDateBasis: "interaction_date",
        source: "google_ads",
        truncated: false,
        malformedRows: 0,
        partial: false,
      });
      expect(result.fetchedAt).toBeTruthy();
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        ...expectRow,
        date: "2026-09-01",
        metrics: {
          impressions: 20342,
          clicks: 14276,
          costMicros: 2500000,
          conversions: 2.5,
          conversionsValue: 50,
        },
      });
      const { url, init } = callAt(0);
      expect(url).toBe(`${BASE}/customers/${CUSTOMER_ID}/googleAds:search`);
      expect(init).toMatchObject({ method: "POST" });
      const headers = headersOf(init);
      expect(headers.authorization).toBe("Bearer test-token");
      expect(headers["login-customer-id"]).toBe(MANAGER_ID);
      expect(headers["developer-token"]).toBeUndefined();
      // v26 search body: query + optional pageToken ONLY. pageSize (and
      // page_size) are rejected upstream and never sent.
      const body = bodyRecord(init);
      expect(Object.keys(body)).toEqual(["query"]);
      expect(body).not.toHaveProperty("pageSize");
      expect(body).not.toHaveProperty("page_size");
      expect(body.query).toContain(from);
      for (const metric of [
        "metrics.impressions",
        "metrics.clicks",
        "metrics.cost_micros",
        "metrics.conversions",
        "metrics.conversions_value",
        "segments.date",
      ]) {
        expect(body.query).toContain(metric);
      }
    },
  );

  it("preserves a full unexpanded landing URL for downstream canonical-page identity", async () => {
    fetchMock.mockResolvedValueOnce(searchResponse([ROWS.landing_page]));
    const facts: GoogleAdsDailyFactsResult<GoogleAdsDailyLandingPageRow> =
      await client().getDailyLandingPageFacts(WINDOW);
    expect(facts.rows[0]).toMatchObject({
      campaignResourceId: "customers/4897513260/campaigns/18835700179",
      landingPageUrl:
        "https://www.example.com/backpacks?gclid=CPtWsq-bnmsXCFZtoQodEcgBRg",
      landingPageResourceId: "customers/4897513260/landingPageViews/cZepkXtkq",
    });
  });

  it("maps device rows onto the mandatory campaign+device storage grain", async () => {
    fetchMock.mockResolvedValueOnce(searchResponse([ROWS.device]));
    const facts: GoogleAdsDailyFactsResult<GoogleAdsDailyDeviceRow> =
      await client().getDailyDeviceFacts(WINDOW);
    expect(facts.rows[0]).toMatchObject({
      campaignResourceId: "customers/4897513260/campaigns/18835700179",
      device: "DESKTOP",
    });
  });

  it("keeps search-term rows at the implicit ad-group grain (never an account total)", async () => {
    fetchMock.mockResolvedValueOnce(
      searchResponse([ROWS.search_term, ROWS.search_term]),
    );
    const facts: GoogleAdsDailyFactsResult<GoogleAdsDailySearchTermRow> =
      await client().getDailySearchTermFacts(WINDOW);
    for (const row of facts.rows) {
      expect(row).toMatchObject({
        searchText: "mountain bike store",
        adGroupResourceId: AD_GROUP.resourceName,
        campaignResourceId: CAMPAIGN.resourceName,
      });
    }
  });

  it("follows page tokens across a multi-page report without pageSize", async () => {
    fetchMock
      .mockResolvedValueOnce(searchResponse([ROWS.campaign], "tok-2"))
      .mockResolvedValueOnce(searchResponse([ROWS.campaign]));
    const input: GoogleAdsDailyFactsInput = {
      ...WINDOW,
      loginCustomerId: null,
    };
    const facts: GoogleAdsDailyFactsResult<GoogleAdsDailyCampaignRow> =
      await client().getDailyCampaignFacts(input);
    expect(facts.rows).toHaveLength(2);
    expect(facts.truncated).toBe(false);
    expect(facts.partial).toBe(false);
    const secondBody = bodyRecord(callAt(1).init);
    expect(secondBody.pageToken).toBe("tok-2");
    expect(Object.keys(secondBody)).toEqual(["query", "pageToken"]);
    expect(headersOf(callAt(0).init)["login-customer-id"]).toBeUndefined();
  });

  it("stops on a repeated page token and reports the traversal as truncated", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(searchResponse([ROWS.device], "tok-loop")),
    );
    const facts = await client().getDailyDeviceFacts(WINDOW);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(facts.truncated).toBe(true);
    expect(facts.partial).toBe(true);
  });

  it("bounds pagination and reports truncated instead of paging forever", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(searchResponse([ROWS.account], "tok-next")),
    );
    const facts = await client().getDailyAccountFacts(WINDOW);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
    expect(facts.truncated).toBe(true);
    expect(facts.partial).toBe(true);
  });

  it("treats an empty omitted-results read as a valid empty success (never a failure)", async () => {
    // All-zero segmented rows are omitted upstream per the Google Ads API
    // zero-metrics contract: a complete day may legitimately read empty;
    // coverage for known zero is the storage layer's concern.
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const empty = await client().getDailySearchTermFacts(WINDOW);
    expect(empty.rows).toEqual([]);
    expect(empty.truncated).toBe(false);
    expect(empty.malformedRows).toBe(0);
    expect(empty.partial).toBe(false);
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: null }));
    const nulled = await client().getDailySearchTermFacts(WINDOW);
    expect(nulled.rows).toEqual([]);
    expect(nulled.partial).toBe(false);
  });

  it("counts malformed rows as partial instead of success-complete", async () => {
    fetchMock.mockResolvedValueOnce(
      searchResponse([
        ROWS.landing_page,
        { landingPageView: { unexpandedFinalUrl: "https://x.test/a" } },
      ]),
    );
    const facts = await client().getDailyLandingPageFacts(WINDOW);
    expect(facts.rows).toHaveLength(1);
    expect(facts.malformedRows).toBe(1);
    expect(facts.partial).toBe(true);
  });

  it("rejects a malformed successful page with the bounded response error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: "SECRET-ROWS" }));
    const thrown = await capture(client().getDailyKeywordFacts(WINDOW));
    expect(thrown).toBeInstanceOf(GoogleAdsMalformedResponseError);
    expect(JSON.stringify(thrown)).not.toContain("SECRET");
  });

  it("retains overlarge int64 cost micros as digits text across the client boundary", async () => {
    const overflow = {
      campaign: CAMPAIGN,
      segments: { date: "2026-09-01" },
      metrics: { ...METRICS, costMicros: "99999999999999999999" },
    };
    fetchMock.mockResolvedValueOnce(searchResponse([overflow]));
    const facts = await client().getDailyCampaignFacts(WINDOW);
    // Same cost fixture in a normal row stays a safe number.
    expect(METRICS.costMicros).toBe("2500000");
    expect(facts.rows[0]).toMatchObject({
      metrics: { costMicros: "99999999999999999999" },
    });
  });

  it("rejects invalid, reversed, overlong and future windows before minting a token", async () => {
    const ads = client();
    const badWindows: Array<Partial<GoogleAdsDailyFactsInput>> = [
      { startDate: "2026-09-30", endDate: "2026-09-01" },
      { startDate: "2026-13-01", endDate: "2026-09-30" },
      { startDate: "2026-02-30", endDate: "2026-09-30" },
      { startDate: "2022-09-01", endDate: "2026-09-30" },
      { endDate: "2026-10-27" },
      { loginCustomerId: "123" },
    ];
    for (const override of badWindows) {
      const thrown = await capture(
        ads.getDailyCampaignFacts({ ...WINDOW, ...override }),
      );
      expect(thrown).toMatchObject({ name: "GoogleAdsRequestError" });
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies quota and access errors the same way it does for discovery reads", async () => {
    fetchMock
      .mockResolvedValueOnce(
        adsErrorResponse(429, { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(429, { quotaError: "RESOURCE_EXHAUSTED" }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(403, { authorizationError: "SERVICE_ACCESS_DENIED" }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(401, { authenticationError: "OAUTH_TOKEN_INVALID" }),
      );
    const ads = client();
    // Temporary quota is retryable; the daily-quota enum is not.
    const temporary = await capture(ads.getDailyAdGroupFacts(WINDOW));
    expect(classifyGoogleAdsError(temporary)).toMatchObject({
      errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
      retryable: true,
    });
    const persistent = await capture(ads.getDailyAdGroupFacts(WINDOW));
    expect(classifyGoogleAdsError(persistent)).toMatchObject({
      errorClass: "QUOTA_EXHAUSTED",
      retryable: false,
    });
    // A requested-service Cloud restriction is generic: the Keyword Planner
    // example is conditional, not an unconditional diagnosis.
    const denied = await capture(ads.getDailyCampaignFacts(WINDOW));
    const deniedClass = classifyGoogleAdsError(denied);
    expect(deniedClass).toMatchObject({
      errorClass: "API_ACCESS_RESTRICTED",
      retryable: false,
    });
    expect(deniedClass.message).toContain("requested");
    expect(deniedClass.message).toContain("for example");
    expect(JSON.stringify(deniedClass.message)).not.toContain("SECRET");
    const oauth = await capture(ads.getDailyCampaignFacts(WINDOW));
    expect(classifyGoogleAdsError(oauth)).toMatchObject({
      errorClass: "OAUTH_TOKEN_INVALID",
      retryable: false,
    });
  });

  it("maps row metrics through the account grain without re-aggregating grains", async () => {
    fetchMock.mockResolvedValueOnce(
      searchResponse([ROWS.account, ROWS.campaign]),
    );
    // Rows of a foreign grain inside an account read are malformed rows
    // (per-grain queries are separate), never summed into account metrics.
    const thrownFacts = await client().getDailyAccountFacts(WINDOW);
    expect(thrownFacts.rows).toHaveLength(1);
    expect(thrownFacts.malformedRows).toBe(1);
    expect(thrownFacts.partial).toBe(true);
  });
});
