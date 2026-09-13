/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GscSearchAnalyticsRequest } from "@/server/lib/gscClient";
import type * as GscClientModule from "@/server/lib/gscClient";

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  getActiveSyncRun: vi.fn(),
  getLatestSyncRun: vi.fn(),
  getStoredCoverageRange: vi.fn(),
  createSyncRun: vi.fn(),
  updateSyncRun: vi.fn(),
  upsertFacts: vi.fn(),
  querySearchAnalytics: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: {
    getByProjectId: mocks.getByProjectId,
  },
}));

vi.mock(
  "@/server/features/gsc/repositories/GscSearchPerformanceRepository",
  () => ({
    deterministicGscFactId: vi.fn().mockResolvedValue("fact_123"),
    GscSearchPerformanceRepository: {
      getActiveSyncRun: mocks.getActiveSyncRun,
      getLatestSyncRun: mocks.getLatestSyncRun,
      getStoredCoverageRange: mocks.getStoredCoverageRange,
      createSyncRun: mocks.createSyncRun,
      updateSyncRun: mocks.updateSyncRun,
      upsertFacts: mocks.upsertFacts,
    },
  }),
);

vi.mock("@/server/lib/gscClient", async (importOriginal) => {
  const actual = await importOriginal<typeof GscClientModule>();
  return {
    ...actual,
    createGscClient: () => ({
      querySearchAnalytics: mocks.querySearchAnalytics,
    }),
  };
});

import {
  GscSyncService,
  classifyGscSyncError,
  normalizeGscRow,
  splitDateRangeIntoChunks,
} from "./GscSyncService";
import {
  GscApiError,
  GscTokenError,
  type GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";
import { GscNotConnectedError } from "./GscService";

describe("splitDateRangeIntoChunks", () => {
  it("splits a 15-day range into 7-day chunks", () => {
    const chunks = splitDateRangeIntoChunks("2026-05-01", "2026-05-15", 7);
    expect(chunks).toEqual([
      { startDate: "2026-05-01", endDate: "2026-05-07" },
      { startDate: "2026-05-08", endDate: "2026-05-14" },
      { startDate: "2026-05-15", endDate: "2026-05-15" },
    ]);
  });

  it("handles a single day", () => {
    const chunks = splitDateRangeIntoChunks("2026-05-01", "2026-05-01", 7);
    expect(chunks).toEqual([
      { startDate: "2026-05-01", endDate: "2026-05-01" },
    ]);
  });

  it("handles range smaller than chunkDays", () => {
    const chunks = splitDateRangeIntoChunks("2026-05-01", "2026-05-04", 7);
    expect(chunks).toEqual([
      { startDate: "2026-05-01", endDate: "2026-05-04" },
    ]);
  });

  it("returns empty array for invalid or inverted dates", () => {
    expect(splitDateRangeIntoChunks("2026-05-10", "2026-05-01", 7)).toEqual([]);
    expect(splitDateRangeIntoChunks("invalid", "2026-05-01", 7)).toEqual([]);
  });
});

describe("normalizeGscRow", () => {
  const projectId = "proj_123";
  const property = "sc-domain:example.com";

  it("normalizes summary grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01"],
      clicks: 12,
      impressions: 340,
      ctr: 0.035,
      position: 8.4,
    };
    const fact = await normalizeGscRow(raw, "summary", projectId, property);
    expect(fact).not.toBeNull();
    expect(fact?.grain).toBe("summary");
    expect(fact?.date).toBe("2026-05-01");
    expect(fact?.clicks).toBe(12);
    expect(fact?.impressions).toBe(340);
    expect(fact?.query).toBeNull();
    expect(fact?.page).toBeNull();
    expect(fact?.country).toBeNull();
    expect(fact?.device).toBeNull();
  });

  it("normalizes query grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "best coffee maker"],
      clicks: 5,
      impressions: 100,
      ctr: 0.05,
      position: 4.2,
    };
    const fact = await normalizeGscRow(raw, "query", projectId, property);
    expect(fact?.grain).toBe("query");
    expect(fact?.query).toBe("best coffee maker");
    expect(fact?.grainKey).toBe("best coffee maker");
    expect(fact?.page).toBeNull();
  });

  it("normalizes page grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "https://example.com/blog/coffee"],
      clicks: 8,
      impressions: 200,
      ctr: 0.04,
      position: 5.1,
    };
    const fact = await normalizeGscRow(raw, "page", projectId, property);
    expect(fact?.grain).toBe("page");
    expect(fact?.page).toBe("https://example.com/blog/coffee");
    expect(fact?.grainKey).toBe("https://example.com/blog/coffee");
  });

  it("normalizes query_page grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: [
        "2026-05-01",
        "best coffee maker",
        "https://example.com/product/1",
      ],
      clicks: 3,
      impressions: 50,
      ctr: 0.06,
      position: 6.0,
    };
    const fact = await normalizeGscRow(raw, "query_page", projectId, property);
    expect(fact?.grain).toBe("query_page");
    expect(fact?.query).toBe("best coffee maker");
    expect(fact?.page).toBe("https://example.com/product/1");
    expect(fact?.grainKey).toBe(
      "best coffee maker::https://example.com/product/1",
    );
  });

  it("normalizes country grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "USA"],
      clicks: 10,
      impressions: 150,
      ctr: 0.066,
      position: 3.5,
    };
    const fact = await normalizeGscRow(raw, "country", projectId, property);
    expect(fact?.grain).toBe("country");
    expect(fact?.country).toBe("usa");
    expect(fact?.grainKey).toBe("usa");
  });

  it("normalizes device grain", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: ["2026-05-01", "mobile"],
      clicks: 7,
      impressions: 120,
      ctr: 0.058,
      position: 5.0,
    };
    const fact = await normalizeGscRow(raw, "device", projectId, property);
    expect(fact?.grain).toBe("device");
    expect(fact?.device).toBe("MOBILE");
    expect(fact?.grainKey).toBe("MOBILE");
  });

  it("returns null when date key is missing or invalid", async () => {
    const raw: GscSearchAnalyticsRow = {
      keys: [],
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    };
    expect(
      await normalizeGscRow(raw, "summary", projectId, property),
    ).toBeNull();
  });
});

describe("classifyGscSyncError", () => {
  it("classifies token errors", () => {
    const err = new GscTokenError("Token revoked");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("OAUTH_TOKEN_FAILURE");
  });

  it("classifies permission denied (401/403)", () => {
    const err = new GscApiError(403, "Forbidden");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("PERMISSION_DENIED");
  });

  it("classifies rate limits (429)", () => {
    const err = new GscApiError(429, "Too Many Requests");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("classifies not connected", () => {
    const err = new GscNotConnectedError("p1");
    const res = classifyGscSyncError(err);
    expect(res.errorClass).toBe("NOT_CONNECTED");
  });
});

describe("GscSyncService.runSync execution & status determination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getByProjectId.mockResolvedValue({
      id: "conn_1",
      siteUrl: "sc-domain:example.com",
      connectedByUserId: "user_1",
    });
    mocks.getActiveSyncRun.mockResolvedValue(null);
    mocks.createSyncRun.mockResolvedValue({
      ok: true,
      sync: {
        id: "sync_1",
        syncType: "manual",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-01",
        actualLastSuccessfulDate: null,
      },
    });
    mocks.updateSyncRun.mockResolvedValue(undefined);
    mocks.upsertFacts.mockResolvedValue({ inserted: 1 });
  });

  it("completes successfully when all requested dates return data", async () => {
    mocks.querySearchAnalytics.mockResolvedValue([
      {
        keys: ["2026-05-01"],
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 5,
      },
    ]);

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    expect(result.status).toBe("completed");
    expect(result.ok).toBe(true);
    expect(result.lastSuccessfulDate).toBe("2026-05-01");
    expect(result.rowsInserted).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it("classifies outcome as partial (not failed) when recent dates return 0 rows", async () => {
    mocks.createSyncRun.mockResolvedValue({
      ok: true,
      sync: {
        id: "sync_2",
        syncType: "manual",
        requestedStartDate: "2026-09-08",
        requestedEndDate: "2026-09-14",
        actualLastSuccessfulDate: null,
      },
    });

    // Return rows for 2026-09-08, but empty rows for subsequent recent chunks
    mocks.querySearchAnalytics.mockImplementation(
      async (_siteUrl: unknown, req: GscSearchAnalyticsRequest) => {
        if (req.startDate === "2026-09-08") {
          return [
            {
              keys: ["2026-09-08"],
              clicks: 5,
              impressions: 50,
              ctr: 0.1,
              position: 4,
            },
          ];
        }
        return [];
      },
    );

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-09-08",
      endDate: "2026-09-14",
      chunkDays: 3,
    });

    expect(result.status).toBe("partial");
    expect(result.ok).toBe(true);
    expect(result.lastSuccessfulDate).toBe("2026-09-08");
    expect(result.error).toBeUndefined();
  });

  it("classifies as failed when genuine Google API error occurs with 0 progress", async () => {
    mocks.querySearchAnalytics.mockRejectedValue(
      new GscApiError(403, "Search Console denied access"),
    );

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-09-01",
      endDate: "2026-09-07",
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("PERMISSION_DENIED");
    expect(result.error).toContain("permission denied");
  });

  it("classifies as failed when authentication fails (token revoked)", async () => {
    mocks.querySearchAnalytics.mockRejectedValue(
      new GscTokenError("Could not mint access token"),
    );

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-09-01",
      endDate: "2026-09-07",
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("OAUTH_TOKEN_FAILURE");
  });

  it("classifies as failed when database persistence fails", async () => {
    mocks.querySearchAnalytics.mockResolvedValue([
      {
        keys: ["2026-09-01"],
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 5,
      },
    ]);
    mocks.upsertFacts.mockRejectedValue(
      new Error("Database transaction aborted"),
    );

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-09-01",
      endDate: "2026-09-07",
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("SYNC_FAILURE");
  });

  it("completes successfully when historical range returns 0 rows (zero search traffic is covered)", async () => {
    // Historical range: 2026-05-01 to 2026-05-07 (well before recent lag)
    mocks.createSyncRun.mockResolvedValue({
      ok: true,
      sync: {
        id: "sync_hist_zero",
        syncType: "manual",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-07",
        actualLastSuccessfulDate: null,
      },
    });

    // Provider returns empty rows (HTTP 200 OK, site had 0 impressions)
    mocks.querySearchAnalytics.mockResolvedValue([]);

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-05-01",
      endDate: "2026-05-07",
    });

    expect(result.status).toBe("completed");
    expect(result.ok).toBe(true);
    expect(result.lastSuccessfulDate).toBe("2026-05-07");
    expect(result.rowsInserted).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("advances lastSuccessfulDate to chunk.endDate for historical chunk even if trailing days return 0 rows", async () => {
    mocks.createSyncRun.mockResolvedValue({
      ok: true,
      sync: {
        id: "sync_hist_trailing",
        syncType: "manual",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-07",
        actualLastSuccessfulDate: null,
      },
    });

    // Only 2026-05-01 had traffic; 2026-05-02..2026-05-07 had 0 rows
    mocks.querySearchAnalytics.mockResolvedValue([
      {
        keys: ["2026-05-01"],
        clicks: 3,
        impressions: 20,
        ctr: 0.15,
        position: 3.2,
      },
    ]);

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: "2026-05-01",
      endDate: "2026-05-07",
    });

    expect(result.status).toBe("completed");
    expect(result.ok).toBe(true);
    // Covers the entire chunk through 2026-05-07, not stalled at 2026-05-01
    expect(result.lastSuccessfulDate).toBe("2026-05-07");
    expect(result.rowsInserted).toBeGreaterThan(0);
  });

  it("handles delayed GSC availability beyond 3 days (e.g. 5-day delay) without falsely claiming coverage", async () => {
    const todayUtc = new Date().toISOString().slice(0, 10);
    const msDay = 24 * 60 * 60 * 1000;
    const todayMs = Date.parse(`${todayUtc}T00:00:00Z`);

    const fiveDaysAgo = new Date(todayMs - 5 * msDay)
      .toISOString()
      .slice(0, 10);
    const fourDaysAgo = new Date(todayMs - 4 * msDay)
      .toISOString()
      .slice(0, 10);
    const sevenDaysAgo = new Date(todayMs - 7 * msDay)
      .toISOString()
      .slice(0, 10);

    mocks.createSyncRun.mockResolvedValue({
      ok: true,
      sync: {
        id: "sync_delayed_lag",
        syncType: "manual",
        requestedStartDate: sevenDaysAgo,
        requestedEndDate: todayUtc,
        actualLastSuccessfulDate: null,
      },
    });

    // Google has a 5-day delay: data exists up to 5 days ago, but 4 days ago..today return 0 rows
    mocks.querySearchAnalytics.mockImplementation(
      async (_siteUrl: unknown, req: GscSearchAnalyticsRequest) => {
        if (req.startDate <= fiveDaysAgo) {
          return [
            {
              keys: [fiveDaysAgo],
              clicks: 10,
              impressions: 100,
              ctr: 0.1,
              position: 4,
            },
          ];
        }
        return [];
      },
    );

    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: sevenDaysAgo,
      endDate: todayUtc,
    });

    expect(result.status).toBe("partial");
    expect(result.ok).toBe(true);
    // Crucial: lastSuccessfulDate stops at 5 days ago (the last corroborated date),
    // and does NOT falsely claim 4 days ago is covered just because 4 > 3!
    expect(result.lastSuccessfulDate).toBe(fiveDaysAgo);
    expect(result.lastSuccessfulDate).not.toBe(fourDaysAgo);
    expect(result.lastSuccessfulDate).not.toBe(todayUtc);
  });

  it("respects configurable dataLagDays option", async () => {
    const todayUtc = new Date().toISOString().slice(0, 10);
    const msDay = 24 * 60 * 60 * 1000;
    const todayMs = Date.parse(`${todayUtc}T00:00:00Z`);

    const twoDaysAgo = new Date(todayMs - 2 * msDay).toISOString().slice(0, 10);
    const fourDaysAgo = new Date(todayMs - 4 * msDay)
      .toISOString()
      .slice(0, 10);

    mocks.createSyncRun.mockResolvedValue({
      ok: true,
      sync: {
        id: "sync_custom_lag",
        syncType: "manual",
        requestedStartDate: fourDaysAgo,
        requestedEndDate: twoDaysAgo,
        actualLastSuccessfulDate: null,
      },
    });

    mocks.querySearchAnalytics.mockResolvedValue([
      {
        keys: [twoDaysAgo],
        clicks: 5,
        impressions: 50,
        ctr: 0.1,
        position: 3,
      },
    ]);

    // Pass custom dataLagDays: 1 day (so 2 days ago is considered historical/finalized)
    const result = await GscSyncService.runSync({
      projectId: "proj_1",
      startDate: fourDaysAgo,
      endDate: twoDaysAgo,
      dataLagDays: 1,
    });

    expect(result.status).toBe("completed");
    expect(result.ok).toBe(true);
    expect(result.lastSuccessfulDate).toBe(twoDaysAgo);
  });
});
