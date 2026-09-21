/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ga4ClientModule from "@/server/lib/ga4Client";
import type { createGa4Client } from "@/server/lib/ga4Client";
import type { Ga4ReportResult } from "@/server/lib/ga4Client";
import type { Ga4ConnectionRepository } from "../repositories/Ga4ConnectionRepository";
import type { Ga4SyncRepository } from "../repositories/Ga4SyncRepository";

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
  getConnection: vi.fn<Ga4ConnectionRepository["getByProjectId"]>(),
  updateCapabilities:
    vi.fn<Ga4ConnectionRepository["updateConnectionCapabilities"]>(),
  getActiveSyncRun: vi.fn<Ga4SyncRepository["getActiveSyncRun"]>(),
  getLatestSyncRun: vi.fn<Ga4SyncRepository["getLatestSyncRun"]>(),
  createSyncRun: vi.fn<Ga4SyncRepository["createSyncRun"]>(),
  updateSyncRun: vi.fn<Ga4SyncRepository["updateSyncRun"]>(),
  markStaleRunsFailed: vi.fn<Ga4SyncRepository["markStaleRunsFailed"]>(),
  seedPendingUnits: vi.fn<Ga4SyncRepository["seedPendingUnits"]>(),
  markUnits: vi.fn<(units: MarkUnitsCall[]) => Promise<void>>(),
  getCoverageMap: vi.fn<Ga4SyncRepository["getCoverageMap"]>(),
  getLastFullyCoveredDate:
    vi.fn<Ga4SyncRepository["getLastFullyCoveredDate"]>(),
  upsertSummaryRows: vi.fn<Ga4SyncRepository["upsertSummaryRows"]>(),
  upsertAcquisitionRows: vi.fn<Ga4SyncRepository["upsertAcquisitionRows"]>(),
  upsertLandingRows: vi.fn<Ga4SyncRepository["upsertLandingRows"]>(),
  upsertEventRows: vi.fn<Ga4SyncRepository["upsertEventRows"]>(),
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
};

const SYNC_ROW = {
  id: "sync-1",
  projectId: "p1",
  propertyId: "42",
  syncType: "initial",
  requestedStartDate: "2025-01-01",
  requestedEndDate: "2025-01-07",
  status: "running",
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
  it("completes a full window with one batch call per chunk", async () => {
    const result = await Ga4SyncService.runSync({
      projectId: "p1",
      organizationId: "o1",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(result.status).toBe("completed");
    expect(result.ok).toBe(true);
    expect(result.successfulUnits).toBe(28);
    expect(mocks.batchRunReports).toHaveBeenCalledTimes(1);
    expect(mocks.batchRunReports.mock.calls[0][0]).toHaveLength(5);
    expect(mocks.upsertSummaryRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAcquisitionRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertLandingRows).toHaveBeenCalledTimes(1);
    expect(mocks.upsertEventRows).toHaveBeenCalledTimes(1);
    const marked = mocks.markUnits.mock.calls.flatMap((call) => call[0]);
    expect(marked).toHaveLength(28);
    expect(marked.every((unit) => unit.status === "SUCCESS_WITH_DATA")).toBe(
      true,
    );
    expect(mocks.updateSyncRun).toHaveBeenLastCalledWith(
      "sync-1",
      expect.objectContaining({ status: "completed", successfulUnits: 28 }),
    );
  });

  it("skips fully-covered chunks with zero HTTP calls", async () => {
    const covered = new Map();
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
    expect(result.successfulUnits).toBe(28);
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
    expect(marked).toHaveLength(28);
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
    expect(marked).toHaveLength(28);
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
