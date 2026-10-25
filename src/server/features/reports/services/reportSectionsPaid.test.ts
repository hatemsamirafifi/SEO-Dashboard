import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }, schema] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("@/db/schema"),
  ]);
  return { db: drizzle(createClient({ url: "file::memory:" }), { schema }) };
});

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  listUnits: vi.fn(),
  sumAccountWindow: vi.fn(),
  sumCampaignWindow: vi.fn(),
  sumSearchTermWindow: vi.fn(),
}));

vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository",
  () => ({
    GoogleAdsConnectionRepository: {
      getByProjectId: mocks.getByProjectId,
    },
  }),
);

vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsAnalyticsRepository",
  () => ({
    GoogleAdsAnalyticsRepository: {
      listUnits: mocks.listUnits,
      sumAccountWindow: mocks.sumAccountWindow,
      sumCampaignWindow: mocks.sumCampaignWindow,
      sumSearchTermWindow: mocks.sumSearchTermWindow,
    },
  }),
);

import { collectPaidSearch } from "./reportSections";

function unitRow(
  date: string,
  status: string = "success_with_data",
  metricDateBasis: string | null = "month",
): {
  date: string;
  status: string;
  publishedGenerationId: string | null;
  metricDateBasis: string | null;
} {
  return { date, status, publishedGenerationId: "gen-1", metricDateBasis };
}

// A full 7-day window ending 2026-10-07 plus the equal 7-day predecessor.
const WINDOW_START = "2026-10-01";
const WINDOW_END = "2026-10-07";
const PREV_START = "2026-09-24";
const PREV_END = "2026-09-30";

function fullUnitWindow(
  startDate: string,
  endDate: string,
  status = "success_with_data",
): ReturnType<typeof unitRow>[] {
  const rows: ReturnType<typeof unitRow>[] = [];
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  for (
    let ts = current.getTime(), endTs = end.getTime();
    ts <= endTs;
    ts += 86_400_000
  ) {
    rows.push(unitRow(new Date(ts).toISOString().slice(0, 10), status));
  }
  return rows;
}

const metric = (
  total: number | null,
  hasMissingComponents = false,
): { total: number | null; hasMissingComponents: boolean } => ({
  total,
  hasMissingComponents,
});

function sums(
  overrides: {
    impressions?: { total: number | null; hasMissingComponents?: boolean };
    clicks?: { total: number | null; hasMissingComponents?: boolean };
    costMicros?: { total: number | null; hasMissingComponents?: boolean };
    conversions?: { total: number | null; hasMissingComponents?: boolean };
    conversionsValue?: { total: number | null; hasMissingComponents?: boolean };
  } = {},
) {
  return {
    rowCount: 7,
    impressions: overrides.impressions ?? metric(1000),
    clicks: overrides.clicks ?? metric(100),
    costMicros: overrides.costMicros ?? metric(150_000_000),
    conversions: overrides.conversions ?? metric(5),
    conversionsValue: overrides.conversionsValue ?? metric(900),
  };
}

beforeAll(async () => {});

describe("collectPaidSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getByProjectId.mockResolvedValue({
      projectId: "project-1",
      organizationId: "org-1",
      customerId: "1234567890",
      currencyCode: "USD",
    });
    const monthUnits = fullUnitWindow(WINDOW_START, WINDOW_END);
    const priorUnits = fullUnitWindow(PREV_START, PREV_END);
    mocks.listUnits.mockImplementation(
      async (_scope: unknown, options: { startDate: string }) =>
        options.startDate === PREV_START ? priorUnits : monthUnits,
    );
    mocks.sumAccountWindow.mockImplementation(
      async (_scope: unknown, window: { startDate: string }) =>
        window.startDate === PREV_START
          ? sums({
              costMicros: { total: 140_000_000 },
              conversionsValue: { total: 850 },
              conversions: { total: 4 },
            })
          : sums(),
    );
    mocks.sumCampaignWindow.mockResolvedValue([
      {
        campaignResourceId: "1",
        campaignName: "Generic",
        campaignStatus: "ENABLED",
        campaignServingStatus: null,
        advertisingChannelType: null,
        sums: sums({ costMicros: { total: 60_000_000 } }),
      },
      {
        campaignResourceId: "2",
        campaignName: "Brand",
        campaignStatus: "ENABLED",
        campaignServingStatus: null,
        advertisingChannelType: null,
        sums: sums({ costMicros: { total: 80_000_000 } }),
      },
    ]);
    mocks.sumSearchTermWindow.mockResolvedValue([
      {
        campaignResourceId: "1",
        adGroupResourceId: "11",
        searchText: "kw",
        keywordText: null,
        keywordMatchType: null,
        sums: sums({
          costMicros: { total: 30_000_000 },
          conversions: { total: null, hasMissingComponents: true },
        }),
      },
      {
        campaignResourceId: "1",
        adGroupResourceId: "12",
        searchText: "kw",
        keywordText: null,
        keywordMatchType: null,
        sums: sums({ costMicros: { total: 20_000_000 } }),
      },
      {
        campaignResourceId: "2",
        adGroupResourceId: "21",
        searchText: "brand term",
        keywordText: null,
        keywordMatchType: null,
        sums: sums({ costMicros: { total: 10_000_000 } }),
      },
    ]);
  });

  it("sums the covered account window with a gated prior comparison", async () => {
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.status).toEqual({ available: true, reason: null });
    expect(paid.currencyCode).toBe("USD");
    expect(paid.metricDateBasis).toBe("month");
    expect(paid.totals).toMatchObject({
      impressions: 1000,
      clicks: 100,
      cost: 150,
      ctr: 0.1,
      cpc: 1.5,
      cpa: 30,
      roas: 6,
    });
    expect(paid.previousTotals).toMatchObject({ cost: 140 });
    expect(paid.deltas).toHaveLength(5);
    expect(mocks.sumAccountWindow).toHaveBeenCalledTimes(2);
  });

  it("ranks campaigns by cost desc and combines search terms per term", async () => {
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.campaigns.map((row) => row.name)).toEqual(["Brand", "Generic"]);
    const kw = paid.searchTerms.find((row) => row.searchText === "kw");
    expect(kw).toBeDefined();
    // Two ad-group rows for the same search text are combined additively.
    expect(kw?.totals).toMatchObject({ cost: 50 });
    // conversions was missing on one component: stay null, never guess.
    expect(kw?.totals.conversions).toBeNull();
    expect(kw?.totals.cpa).toBeNull();
  });

  it("reports no_coverage (with connection currency) on partial coverage", async () => {
    const sparse = fullUnitWindow(WINDOW_START, WINDOW_END);
    const priorUnits = fullUnitWindow(PREV_START, PREV_END);
    mocks.listUnits.mockImplementation(
      async (_scope: unknown, options: { startDate: string }) =>
        options.startDate === PREV_START ? priorUnits : sparse.slice(0, 3),
    );
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.status).toEqual({ available: false, reason: "no_coverage" });
    expect(paid.totals).toBeNull();
    expect(paid.currencyCode).toBe("USD");
    expect(mocks.sumAccountWindow).not.toHaveBeenCalled();
  });

  it("keeps published data available when the equal-length gate is not ready", async () => {
    // Predecessor coverage gaps block the comparison but not the headline.
    const monthUnits = fullUnitWindow(WINDOW_START, WINDOW_END);
    const priorUnits = fullUnitWindow(PREV_START, PREV_END).slice(0, 2);
    mocks.listUnits.mockImplementation(
      async (_scope: unknown, options: { startDate: string }) =>
        options.startDate === PREV_START ? priorUnits : monthUnits,
    );
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.status.available).toBe(true);
    expect(paid.previousTotals).toBeNull();
    expect(paid.deltas).toEqual([]);
    expect(paid.totals?.cost).toBe(150);
  });

  it("renders a fully covered empty window as available with no totals", async () => {
    mocks.sumAccountWindow.mockImplementation(
      async (_scope: unknown, _window: unknown) =>
        sums({
          impressions: { total: null },
          clicks: { total: null },
          costMicros: { total: null },
          conversions: { total: null },
          conversionsValue: { total: null },
        }),
    );
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.status).toEqual({ available: true, reason: null });
    expect(paid.totals).toBeNull();
    expect(paid.campaigns).toEqual([]);
    expect(paid.searchTerms).toEqual([]);
  });

  it("stays not_connected without a connection, never failing", async () => {
    mocks.getByProjectId.mockResolvedValue(null);
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.status).toEqual({ available: false, reason: "not_connected" });
    expect(mocks.listUnits).not.toHaveBeenCalled();
  });

  it("keeps the section honest when the repository fails", async () => {
    mocks.sumAccountWindow.mockRejectedValue(new Error("storage down"));
    const paid = await collectPaidSearch(
      "project-1",
      "org-1",
      WINDOW_START,
      WINDOW_END,
    );
    expect(paid.status).toEqual({
      available: false,
      reason: "provider_failed",
    });
  });
});
