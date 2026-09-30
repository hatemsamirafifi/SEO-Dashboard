/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ga4ClientModule from "@/server/lib/ga4Client";
import type { createGa4Client } from "@/server/lib/ga4Client";
import type { Ga4ReportResult } from "@/server/lib/ga4Client";
import type { Ga4Connection } from "../repositories/Ga4ConnectionRepository";
// oxlint-disable-next-line typescript/consistent-type-imports -- typeof queries need the value import; erased to types only
import { Ga4ConnectionRepository } from "../repositories/Ga4ConnectionRepository";
// oxlint-disable-next-line typescript/consistent-type-imports -- typeof queries need the value import; erased to types only
import { Ga4SyncRepository } from "../repositories/Ga4SyncRepository";
import type {
  Ga4CoverageStatus,
  Ga4SyncGrain,
} from "./ga4SyncUtils";

type Ga4Client = ReturnType<typeof createGa4Client>;

type MarkUnitsCall = {
  projectId: string;
  propertyId: string;
  date: string;
  grain: string;
  status: string;
  truncationMeta: unknown;
};

const mocks = vi.hoisted(() => ({
  getConnection:
    vi.fn<
      (
        projectId: string,
        organizationId: string,
      ) => Promise<Ga4Connection | null>
    >(),
  updateCapabilities:
    vi.fn<(typeof Ga4ConnectionRepository)["updateConnectionCapabilities"]>(),
  getActiveSyncRun: vi.fn<(typeof Ga4SyncRepository)["getActiveSyncRun"]>(),
  getLatestSyncRun: vi.fn<(typeof Ga4SyncRepository)["getLatestSyncRun"]>(),
  createSyncRun: vi.fn<(typeof Ga4SyncRepository)["createSyncRun"]>(),
  updateSyncRun: vi.fn<(typeof Ga4SyncRepository)["updateSyncRun"]>(),
  markStaleRunsFailed:
    vi.fn<(typeof Ga4SyncRepository)["markStaleRunsFailed"]>(),
  seedPendingUnits: vi.fn<(typeof Ga4SyncRepository)["seedPendingUnits"]>(),
  markUnits: vi.fn<(units: MarkUnitsCall[]) => Promise<void>>(),
  getCoverageMap: vi.fn<(typeof Ga4SyncRepository)["getCoverageMap"]>(),
  getLastFullyCoveredDate:
    vi.fn<(typeof Ga4SyncRepository)["getLastFullyCoveredDate"]>(),
  upsertSummaryRows: vi.fn<(typeof Ga4SyncRepository)["upsertSummaryRows"]>(),
  upsertAcquisitionRows:
    vi.fn<(typeof Ga4SyncRepository)["upsertAcquisitionRows"]>(),
  upsertLandingRows: vi.fn<(typeof Ga4SyncRepository)["upsertLandingRows"]>(),
  upsertEventRows: vi.fn<(typeof Ga4SyncRepository)["upsertEventRows"]>(),
  upsertGeoRows: vi.fn(),
  upsertTechnologyRows: vi.fn(),
  deterministicFactId: vi.fn(async () => "fact-id"),
  runReport: vi.fn<Ga4Client["runReport"]>(),
  batchRunReports: vi.fn<Ga4Client["batchRunReports"]>(),
  getPropertyCreateTime: vi.fn<Ga4Client["getPropertyCreateTime"]>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: {
    getByProjectId: mocks.getConnection,
    updateConnectionCapabilities: mocks.updateCapabilities,
  },
}));

vi.mock("@/server/features/ga4/repositories/Ga4SyncRepository", () => ({
  Ga4SyncRepository: {
    getActiveSyncRun: mocks.getActiveSyncRun,
    getLatestSyncRun: mocks.getLatestSyncRun,
    createSyncRun: mocks.createSyncRun,
    updateSyncRun: mocks.updateSyncRun,
    markStaleRunsFailed: mocks.markStaleRunsFailed,
    seedPendingUnits: mocks.seedPendingUnits,
    markUnits: mocks.markUnits,
    getCoverageMap: mocks.getCoverageMap,
    getLastFullyCoveredDate: mocks.getLastFullyCoveredDate,
    upsertSummaryRows: mocks.upsertSummaryRows,
    upsertAcquisitionRows: mocks.upsertAcquisitionRows,
    upsertLandingRows: mocks.upsertLandingRows,
    upsertEventRows: mocks.upsertEventRows,
    upsertGeoRows: mocks.upsertGeoRows,
    upsertTechnologyRows: mocks.upsertTechnologyRows,
  },
  deterministicGa4FactId: mocks.deterministicFactId,
}));

vi.mock("@/server/lib/ga4Client", async (importOriginal) => {
  const actual = await importOriginal<typeof Ga4ClientModule>();
  return {
    ...actual,
    createGa4Client: () => ({
      runReport: mocks.runReport,
      batchRunReports: mocks.batchRunReports,
      getPropertyCreateTime: mocks.getPropertyCreateTime,
    }),
  };
});

import { Ga4SyncService } from "./Ga4SyncService";
import {
  Ga4ApiError,
  Ga4NotConnectedError,
  Ga4TokenError,
} from "@/server/lib/ga4Client";

const CONNECTION = {
  id: "conn-1",
  projectId: "p1",
  organizationId: "o1",
  propertyId: "42",
  propertyDisplayName: "Main",
  connectedByUserId: "u1",
  ga4AccountId: "acc1",
  currencyCode: null,
  hasEcommerce: false,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const SYNC_ROW = {
  id: "sync-1",
  projectId: "p1",
  ga4ConnectionId: "conn-1",
  propertyId: "42",
  syncType: "initial",
  requestedStartDate: "2025-01-01",
  requestedEndDate: "2025-01-07",
  status: "running",
  startedAt: "2025-01-08T00:00:00.000Z",
  completedAt: null,
  rowsFetched: 0,
  rowsInserted: 0,
  rowsUpdated: 0,
  rowsFailed: 0,
  successfulUnits: 0,
  error: null,
  errorClass: null,
  checkpoint: null,
  createdAt: "2025-01-08T00:00:00.000Z",
  updatedAt: "2025-01-08T00:00:00.000Z",
};

function report(
  rows: Array<{ dimensionValues: string[]; metricValues: number[] }>,
  extra: Partial<Ga4ReportResult> = {},
): Ga4ReportResult {
  return {
    rowCount: rows.length,
    rows,
    metadata: {
      samplingState: "NOT_SAMPLED",
      isTruncated: false,
      currencyCode: null,
    },
    ...extra,
  };
}

function weekBatch(dates: string[]) {
  const core = dates.map((date) => ({
    dimensionValues: [date],
    metricValues: [10, 5, 100, 20, 30, 4, 90, 80],
  }));
  const revenue = dates.map((date) => ({
    dimensionValues: [date],
    metricValues: [0, 0, 0, 0, 0],
  }));
  const acquisition = dates.flatMap((date) => [
    {
      dimensionValues: [date, "Organic Search", "google", "organic"],
      metricValues: [7, 3, 60, 14, 21, 2],
    },
  ]);
  const landing = dates.map((date) => ({
    dimensionValues: [date, "/pricing"],
    metricValues: [5, 2, 40, 9],
  }));
  const events = dates.map((date) => ({
    dimensionValues: [date, "click"],
    metricValues: [12, 0],
  }));
  return [
    report(core),
    report(revenue),
    report(acquisition),
    report(landing),
    report(events),
  ];
}

const DATES_7 = [
  "20250101",
  "20250102",
  "20250103",
  "20250104",
  "20250105",
  "20250106",
  "20250107",
];

function geoFixture(dates: string[]) {
  return dates.flatMap((date) => [
    {
      dimensionValues: [date, "United States"],
      metricValues: [7, 5, 60, 14, 21, 3],
    },
    {
      dimensionValues: [date, "Germany"],
      metricValues: [3, 2, 40, 6, 9, 1],
    },
  ]);
}

function techFixture(dates: string[]) {
  return dates.flatMap((date) => [
    {
      dimensionValues: [date, "desktop", "Chrome", "Windows"],
      metricValues: [6, 4, 55, 12, 18, 2],
    },
    {
      dimensionValues: [date, "mobile", "Safari", "iOS"],
      metricValues: [4, 3, 45, 8, 12, 2],
    },
  ]);
}

/** Default geo/tech reads: data-bearing single pages routed by dimension so
 *  happy-path windows cover all six grains. Per-date geo sessions (7+3) and
 *  tech sessions (6+4) reconcile with the summary 10. */
function geoTechDefault(request: { dimensions?: string[] }): Ga4ReportResult {
  const dimensions = request.dimensions ?? [];
  if (dimensions.includes("country")) return report(geoFixture(DATES_7));
  if (dimensions.includes("deviceCategory")) return report(techFixture(DATES_7));
  return report([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConnection.mockResolvedValue(CONNECTION);
  mocks.getActiveSyncRun.mockResolvedValue(null);
  mocks.markStaleRunsFailed.mockResolvedValue(0);
  mocks.createSyncRun.mockResolvedValue({ ok: true, sync: SYNC_ROW });
  mocks.getCoverageMap.mockResolvedValue(new Map());
  mocks.getLastFullyCoveredDate.mockResolvedValue("2025-01-07");
  mocks.getPropertyCreateTime.mockResolvedValue("2024-01-15");
  mocks.batchRunReports.mockResolvedValue(weekBatch(DATES_7));
    mocks.runReport.mockImplementation(async (request) =>
      geoTechDefault(request),
    );
});

describe("Ga4SyncService.runSync connection and concurrency", () => {
  it("throws NOT_CONNECTED without creating a run when no connection exists", async () => {
    mocks.getConnection.mockResolvedValueOnce(null);
    await expect(
      Ga4SyncService.runSync({ projectId: "p1", organizationId: "o1" }),
    ).rejects.toBeInstanceOf(Ga4NotConnectedError);
    expect(mocks.createSyncRun).not.toHaveBeenCalled();
    expect(mocks.batchRunReports).not.toHaveBeenCalled();
  });

  it("returns alreadyRunning when a run is active", async () => {
    mocks.getActiveSyncRun.mockResolvedValueOnce({ ...SYNC_ROW, id: "old" });
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.syncId).toBe("old");
    expect(mocks.batchRunReports).not.toHaveBeenCalled();
  });

  it("recovers a stale active run before proceeding", async () => {
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(mocks.markStaleRunsFailed).toHaveBeenCalledWith(
      "p1",
      "42",
      expect.any(String),
    );
    expect(result.status).toBe("completed");
  });
});

describe("Ga4SyncService.runSync successful windows", () => {
  it("force-resets units on manual explicit windows but not on incremental runs", async () => {
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(mocks.seedPendingUnits).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
    vi.clearAllMocks();
    mocks.getConnection.mockResolvedValue(CONNECTION);
    mocks.getActiveSyncRun.mockResolvedValue(null);
    mocks.createSyncRun.mockResolvedValue({ ok: true, sync: SYNC_ROW });
    mocks.getCoverageMap.mockResolvedValue(new Map());
    mocks.getLastFullyCoveredDate.mockResolvedValue("2025-01-07");
    mocks.batchRunReports.mockResolvedValue(weekBatch(DATES_7));
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      syncType: "incremental",
    });
    expect(mocks.seedPendingUnits).toHaveBeenCalledWith(
      expect.objectContaining({ force: false }),
    );
  });

  it("completes a full window with one batch call per chunk", async () => {
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("completed");
    expect(result.ok).toBe(true);
    expect(result.successfulUnits).toBe(42);
    expect(mocks.batchRunReports).toHaveBeenCalledTimes(1);
    expect(mocks.batchRunReports.mock.calls[0][0]).toHaveLength(5);
    expect(mocks.upsertSummaryRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAcquisitionRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertLandingRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertEventRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertGeoRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertTechnologyRows).toHaveBeenCalledTimes(1);
    const marked = mocks.markUnits.mock.calls.flatMap((call) => call[0]);
    expect(marked).toHaveLength(42);
    expect(marked.every((unit) => unit.status === "SUCCESS_WITH_DATA")).toBe(
      true,
    );
    expect(mocks.updateSyncRun).toHaveBeenLastCalledWith(
      "sync-1",
      expect.objectContaining({ status: "completed", successfulUnits: 42 }),
    );
  });

  it("skips fully-covered chunks with zero HTTP calls", async () => {
    const covered = new Map<string, Map<Ga4SyncGrain, Ga4CoverageStatus>>();
    for (const date of [
      "2025-01-01",
      "2025-01-02",
      "2025-01-03",
      "2025-01-04",
      "2025-01-05",
      "2025-01-06",
      "2025-01-07",
    ]) {
      covered.set(
        date,
        new Map([
          ["summary", "SUCCESS_WITH_DATA"],
          ["acquisition", "SUCCESS_WITH_DATA"],
          ["landing_pages", "SUCCESS_WITH_DATA"],
          ["events", "SUCCESS_WITH_DATA"],
          ["geo", "SUCCESS_WITH_DATA"],
          ["technology", "SUCCESS_WITH_DATA"],
        ]),
      );
    }
    mocks.getCoverageMap.mockResolvedValueOnce(covered);
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("completed");
    expect(mocks.batchRunReports).not.toHaveBeenCalled();
    expect(result.successfulUnits).toBe(0);
  });

  it("marks zero-row units SUCCESS_ZERO_ROWS and completes", async () => {
    mocks.batchRunReports.mockResolvedValueOnce([
      report([]),
      report([]),
      report([]),
      report([]),
      report([]),
    ]);
    mocks.runReport.mockResolvedValueOnce(report([]));
    mocks.runReport.mockResolvedValueOnce(report([]));
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("completed");
    const marked = mocks.markUnits.mock.calls.flatMap((call) => call[0]);
    expect(marked.every((unit) => unit.status === "SUCCESS_ZERO_ROWS")).toBe(
      true,
    );
    expect(mocks.upsertSummaryRows).not.toHaveBeenCalled();
  });
});

describe("Ga4SyncService.runSync failure matrix", () => {
  it("halts on quota with the remainder PENDING and classifies PARTIAL", async () => {
    mocks.batchRunReports
      .mockResolvedValueOnce(weekBatch(DATES_7))
      .mockRejectedValueOnce(new Ga4ApiError(429, "quota"));
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-14",
    });
    expect(result.status).toBe("partial");
    expect(result.errorClass).toBe("QUOTA_EXHAUSTED");
    expect(result.successfulUnits).toBe(42);
    const markedDates = new Set(
      mocks.markUnits.mock.calls.flatMap((call) =>
        call[0].map((unit) => unit.date),
      ),
    );
    for (const date of [
      "2025-01-08",
      "2025-01-09",
      "2025-01-10",
      "2025-01-11",
      "2025-01-12",
      "2025-01-13",
      "2025-01-14",
    ]) {
      expect(markedDates.has(date)).toBe(false);
    }
  });

  it("fails a quota-first run with zero success", async () => {
    mocks.batchRunReports.mockRejectedValueOnce(new Ga4ApiError(429, "quota"));
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("failed");
    expect(result.errorClass).toBe("QUOTA_EXHAUSTED");
    expect(result.successfulUnits).toBe(0);
  });

  it("marks touched units FAILED with reconnect guidance on permission errors", async () => {
    mocks.batchRunReports.mockRejectedValueOnce(new Ga4ApiError(403, "denied"));
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("failed");
    expect(result.errorClass).toBe("PERMISSION_DENIED");
    expect(result.error).toContain("Settings");
    const marked = mocks.markUnits.mock.calls.flatMap((call) => call[0]);
    expect(marked).toHaveLength(42);
    expect(marked.every((unit) => unit.status === "FAILED")).toBe(true);
  });

  it("fails token errors as fatal without partial credit", async () => {
    mocks.batchRunReports
      .mockResolvedValueOnce(weekBatch(DATES_7))
      .mockRejectedValueOnce(new Ga4TokenError("revoked"));
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-14",
    });
    expect(result.status).toBe("failed");
    expect(result.errorClass).toBe("OAUTH_TOKEN_FAILURE");
  });

  it("marks touched units FAILED (never SUCCESS) when metric writes fail", async () => {
    mocks.upsertSummaryRows.mockRejectedValueOnce(new Error("db down"));
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    const marked = mocks.markUnits.mock.calls.flatMap((call) => call[0]);
    expect(marked).toHaveLength(42);
    expect(marked.every((unit) => unit.status === "FAILED")).toBe(true);
    expect(result.successfulUnits).toBe(0);
    expect(result.status).toBe("failed");
  });

  it("latches ecommerce capability and currency from observed metadata", async () => {
    const withRevenue = weekBatch(DATES_7);
    withRevenue[1] = report(
      DATES_7.map((date) => ({
        dimensionValues: [date],
        metricValues: [25, 20, 2, 3, 1],
      })),
      {
        metadata: {
          samplingState: "NOT_SAMPLED",
          isTruncated: false,
          currencyCode: "EUR",
        },
      },
    );
    mocks.batchRunReports.mockResolvedValueOnce(withRevenue);
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(mocks.updateCapabilities).toHaveBeenCalledWith("conn-1", {
      hasEcommerce: true,
      currencyCode: "EUR",
    });
  });

  it("leaves capability flags alone when nothing new is observed", async () => {
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(mocks.updateCapabilities).not.toHaveBeenCalled();
  });

  it("records landing-page truncation metadata on affected units", async () => {
    const batch = weekBatch(DATES_7);
    batch[3] = report(
      DATES_7.map((date) => ({
        dimensionValues: [date, "/pricing"],
        metricValues: [5, 2, 40, 9],
      })),
      { rowCount: 1400 },
    );
    mocks.batchRunReports.mockResolvedValueOnce(batch);
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    const landing = mocks.markUnits.mock.calls
      .flatMap((call) => call[0])
      .filter((unit) => unit.grain === "landing_pages");
    expect(landing).toHaveLength(7);
    for (const unit of landing) {
      expect(unit.truncationMeta).toMatchObject({
        is_truncated: true,
        total_rows_if_known: 1400,
      });
    }
  });

  it("paginates full acquisition pages with offset follow-ups", async () => {
    const fullPage = Array.from({ length: 10_000 }, () => ({
      dimensionValues: ["20250101", "Organic Search", "google", "organic"],
      metricValues: [1, 1, 1, 1, 1, 1],
    }));
    const batch = weekBatch(DATES_7);
    batch[2] = report(fullPage, { rowCount: 10_003 });
    mocks.batchRunReports.mockResolvedValueOnce(batch);
    mocks.runReport.mockResolvedValueOnce(
      report([
        {
          dimensionValues: ["20250101", "Organic Search", "google", "organic"],
          metricValues: [1, 1, 1, 1, 1, 1],
        },
      ]),
    );
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 10_000 }),
    );
  });

  it("counts malformed rows as failed without failing their unit silently", async () => {
    const batch = weekBatch(DATES_7);
    batch[0] = report([
      {
        dimensionValues: ["20250101"],
        metricValues: [10, 5, 100, 20, 30, 4, 90, 80],
      },
      {
        dimensionValues: ["not-a-date"],
        metricValues: [1, 1, 1, 1, 1, 1, 1, 1],
      },
    ]);
    mocks.batchRunReports.mockResolvedValueOnce(batch);
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.rowsFailed).toBeGreaterThan(0);
  });

  it("clamps the initial window to the property creation date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const creation = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86400000)
      .toISOString()
      .slice(0, 10);
    mocks.getPropertyCreateTime.mockResolvedValueOnce(creation);
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      syncType: "initial",
    });
    const subRequests = mocks.batchRunReports.mock.calls[0][0];
    for (const sub of subRequests) {
      expect(sub.dateRanges).toHaveLength(1);
      expect(sub.dateRanges[0]?.startDate).toBe(creation);
    }
  });

  it("surfaces property-creation failures without creating a run", async () => {
    mocks.getPropertyCreateTime.mockRejectedValueOnce(
      new Ga4ApiError(403, "denied"),
    );
    await expect(
      Ga4SyncService.runSync({
        projectId: "p1",
        organizationId: "o1",
        syncType: "initial",
      }),
    ).rejects.toBeInstanceOf(Ga4ApiError);
    expect(mocks.createSyncRun).not.toHaveBeenCalled();
  });
});

describe("Ga4SyncService.runSync geo grain", () => {
  it("ingests per-country rows with deterministic identity and SUCCESS coverage", async () => {
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("completed");
    expect(mocks.upsertGeoRows).toHaveBeenCalledTimes(1);
    const rows = mocks.upsertGeoRows.mock.calls[0][0] as Array<{
      id: string;
      date: string;
      country: string;
      sessions: number;
      newUsers: number;
      isOtherRow: boolean;
    }>;
    expect(rows).toHaveLength(14);
    const us = rows.filter((row) => row.country === "United States");
    expect(us).toHaveLength(7);
    expect(us[0]).toMatchObject({ sessions: 7, newUsers: 3 });
    expect(us[0]?.isOtherRow).toBe(false);
    // Deterministic identity input: 14 distinct (date, country) pairs feed
    // the fact-id hash (the hash itself is a mocked repository seam here).
    const pairs = new Set(rows.map((row) => `${row.date}|${row.country}`));
    expect(pairs.size).toBe(14);
    // Geo per-date sessions reconcile with the summary grain (7 + 3 = 10).
    const byDate = new Map<string, number>();
    for (const row of rows) {
      byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.sessions);
    }
    for (const total of byDate.values()) expect(total).toBe(10);
    const geo = mocks.markUnits.mock.calls
      .flatMap((call) => call[0])
      .filter((unit) => unit.grain === "geo");
    expect(geo).toHaveLength(7);
    expect(geo.every((unit) => unit.status === "SUCCESS_WITH_DATA")).toBe(true);
    for (const unit of geo) {
      expect(unit.truncationMeta).toMatchObject({
        is_truncated: false,
        other_row_present: false,
      });
    }
  });

  it("stores the (not set) sentinel for missing countries", async () => {
    mocks.runReport.mockImplementation(async (request: { dimensions?: string[] }) => {
      if ((request.dimensions ?? []).includes("country")) {
        return report([
          { dimensionValues: ["20250101", ""], metricValues: [4, 1, 9, 3, 5, 1] },
        ]);
      }
      return geoTechDefault(request);
    });
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-01",
    });
    const rows = mocks.upsertGeoRows.mock.calls[0][0] as Array<{
      country: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.country).toBe("(not set)");
  });

  it("rolls dimension overflow into a deterministic (other) row with exact totals", async () => {
    const overflow = Array.from({ length: 301 }, (_, i) => ({
      dimensionValues: ["20250101", `Country ${String(i).padStart(3, "0")}`],
      metricValues: [301 - i, 1, 10, 2, 3, 1],
    }));
    mocks.runReport.mockImplementation(async (request: { dimensions?: string[] }) => {
      if ((request.dimensions ?? []).includes("country")) {
        return report(overflow, { rowCount: 301 });
      }
      return geoTechDefault(request);
    });
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-01",
    });
    const rows = mocks.upsertGeoRows.mock.calls[0][0] as Array<{
      country: string;
      sessions: number;
      isOtherRow: boolean;
    }>;
    // 300 retained + 1 tail row; sessions rank desc so Country 300 folds in.
    expect(rows).toHaveLength(301);
    const other = rows.filter((row) => row.isOtherRow);
    expect(other).toHaveLength(1);
    expect(other[0]?.country).toBe("(other)");
    expect(other[0]?.sessions).toBe(1);
    expect(rows.some((row) => row.country === "Country 300")).toBe(false);
    const geo = mocks.markUnits.mock.calls
      .flatMap((call) => call[0])
      .filter((unit) => unit.grain === "geo");
    expect(geo).toHaveLength(1);
    expect(geo[0]?.truncationMeta).toMatchObject({
      is_truncated: true,
      other_row_present: true,
      omitted_dimension_count: 1,
    });
  });

  it("reprocesses idempotently with identical payloads after failure", async () => {
    const window = {
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    };
    await Ga4SyncService.runSync(window);
    const first = mocks.upsertGeoRows.mock.calls[0][0];
    vi.clearAllMocks();
    mocks.getConnection.mockResolvedValue(CONNECTION);
    mocks.getActiveSyncRun.mockResolvedValue(null);
    mocks.createSyncRun.mockResolvedValue({ ok: true, sync: SYNC_ROW });
  mocks.runReport.mockImplementation(async (request) =>
    geoTechDefault(request),
  );
    const failed = new Map<string, Map<Ga4SyncGrain, Ga4CoverageStatus>>();
    for (const date of [
      "2025-01-01",
      "2025-01-02",
      "2025-01-03",
      "2025-01-04",
      "2025-01-05",
      "2025-01-06",
      "2025-01-07",
    ]) {
      failed.set(
        date,
        new Map([
          ["summary", "SUCCESS_WITH_DATA"],
          ["acquisition", "SUCCESS_WITH_DATA"],
          ["landing_pages", "SUCCESS_WITH_DATA"],
          ["events", "SUCCESS_WITH_DATA"],
          ["geo", "FAILED"],
          ["technology", "SUCCESS_WITH_DATA"],
        ]),
      );
    }
    mocks.getCoverageMap.mockResolvedValue(failed);
    await Ga4SyncService.runSync(window);
    const second = mocks.upsertGeoRows.mock.calls[0][0];
    expect(second).toEqual(first);
  });
});

describe("Ga4SyncService.runSync technology grain", () => {
  it("ingests composite device/browser/os rows with SUCCESS coverage", async () => {
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("completed");
    expect(mocks.upsertTechnologyRows).toHaveBeenCalledTimes(1);
    const rows = mocks.upsertTechnologyRows.mock.calls[0][0] as Array<{
      date: string;
      device: string;
      browser: string;
      os: string;
      sessions: number;
      isOtherRow: boolean;
    }>;
    expect(rows).toHaveLength(14);
    expect(rows[0]).toMatchObject({
      device: "desktop",
      browser: "Chrome",
      os: "Windows",
      sessions: 6,
      isOtherRow: false,
    });
    const pairs = new Set(
      rows.map((row) => `${row.date}|${row.device}|${row.browser}|${row.os}`),
    );
    expect(pairs.size).toBe(14);
    // Tech per-date sessions reconcile with the summary grain (6 + 4 = 10).
    const byDate = new Map<string, number>();
    for (const row of rows) {
      byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.sessions);
    }
    for (const total of byDate.values()) expect(total).toBe(10);
    const tech = mocks.markUnits.mock.calls
      .flatMap((call) => call[0])
      .filter((unit) => unit.grain === "technology");
    expect(tech).toHaveLength(7);
    expect(tech.every((unit) => unit.status === "SUCCESS_WITH_DATA")).toBe(
      true,
    );
  });

  it("rolls composite overflow into one (other) composite row", async () => {
    const overflow = Array.from({ length: 1001 }, (_, i) => ({
      dimensionValues: [
        "20250101",
        `device${i % 3}`,
        `Browser ${String(i).padStart(4, "0")}`,
        "OS",
      ],
      metricValues: [1001 - i, 1, 10, 2, 3, 1],
    }));
    mocks.runReport.mockImplementation(async (request: { dimensions?: string[] }) => {
      if ((request.dimensions ?? []).includes("deviceCategory")) {
        return report(overflow, { rowCount: 1001 });
      }
      return geoTechDefault(request);
    });
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-01",
    });
    const rows = mocks.upsertTechnologyRows.mock.calls[0][0] as Array<{
      device: string;
      browser: string;
      os: string;
      sessions: number;
      isOtherRow: boolean;
    }>;
    expect(rows).toHaveLength(1001);
    const other = rows.filter((row) => row.isOtherRow);
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({
      device: "(other)",
      browser: "(other)",
      os: "(other)",
      sessions: 1,
    });
    const tech = mocks.markUnits.mock.calls
      .flatMap((call) => call[0])
      .filter((unit) => unit.grain === "technology");
    expect(tech).toHaveLength(1);
    expect(tech[0]?.truncationMeta).toMatchObject({
      is_truncated: true,
      other_row_present: true,
      omitted_dimension_count: 1,
    });
  });
});

describe("Ga4SyncService.runSync quota honesty for geo/tech grains", () => {
  it("halts with the remainder PENDING when the geo fetch hits quota", async () => {
    let runReportCalls = 0;
    mocks.runReport.mockImplementation(async (request: { dimensions?: string[] }) => {
      runReportCalls += 1;
      // Chunk 1 (geo + tech) succeeds; chunk 2 geo hits quota.
      if (runReportCalls === 3) {
        throw new Ga4ApiError(429, "quota");
      }
      return geoTechDefault(request);
    });
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-14",
    });
    expect(result.status).toBe("partial");
    expect(result.errorClass).toBe("QUOTA_EXHAUSTED");
    // Chunk 1 finalized all six grains; chunk 2 marked nothing (PENDING).
    expect(result.successfulUnits).toBe(42);
    const marked = mocks.markUnits.mock.calls.flatMap((call) => call[0]);
    expect(marked).toHaveLength(42);
    expect(
      marked.every((unit) => unit.status === "SUCCESS_WITH_DATA"),
    ).toBe(true);
    const markedDates = new Set(marked.map((unit) => unit.date));
    for (const date of [
      "2025-01-08",
      "2025-01-09",
      "2025-01-10",
      "2025-01-11",
      "2025-01-12",
      "2025-01-13",
      "2025-01-14",
    ]) {
      expect(markedDates.has(date)).toBe(false);
    }
  });

  it("seeds all six grains including geo/technology for quota resume", async () => {
    await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(mocks.seedPendingUnits).toHaveBeenCalledWith(
      expect.objectContaining({
        grains: ["summary", "acquisition", "landing_pages", "events", "geo", "technology"],
      }),
    );
  });

  it("backfills quota-pending geo units without duplicates on resume", async () => {
    const window = {
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    };
    let runReportCalls = 0;
    mocks.runReport.mockImplementation(async (request: { dimensions?: string[] }) => {
      runReportCalls += 1;
      if (runReportCalls === 1) throw new Ga4ApiError(429, "quota");
      return geoTechDefault(request);
    });
    const halted = await Ga4SyncService.runSync(window);
    expect(halted.status).toBe("failed");
    expect(halted.errorClass).toBe("QUOTA_EXHAUSTED");
    expect(halted.successfulUnits).toBe(0);
    expect(mocks.upsertGeoRows).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getConnection.mockResolvedValue(CONNECTION);
    mocks.getActiveSyncRun.mockResolvedValue(null);
    mocks.createSyncRun.mockResolvedValue({ ok: true, sync: SYNC_ROW });
    mocks.runReport.mockImplementation(async (request) =>
      geoTechDefault(request),
    );
    const resumed = await Ga4SyncService.runSync(window);
    expect(resumed.status).toBe("completed");
    const rows = mocks.upsertGeoRows.mock.calls[0][0] as Array<{
      date: string;
      country: string;
    }>;
    const pairs = rows.map((row) => `${row.date}|${row.country}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const geo = mocks.markUnits.mock.calls
      .flatMap((call) => call[0])
      .filter((unit) => unit.grain === "geo");
    expect(geo.every((unit) => unit.status === "SUCCESS_WITH_DATA")).toBe(
      true,
    );
  });
});
