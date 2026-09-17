import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asRecord,
  countriesResult,
  extractSqlClauseText,
  strikingResult,
  totalsResult,
  type TestFactRow,
  type TestSyncRow,
} from "./searchPerformanceReportFlowFixtures";

const mocks = vi.hoisted(() => {
  const syncsRows: TestSyncRow[] = [];
  const factRows: TestFactRow[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((clause: unknown) => {
          const isFactTable =
            table &&
            typeof table === "object" &&
            "date" in table &&
            !("requestedStartDate" in table);

          if (isFactTable) {
            return Object.assign(Promise.resolve(factRows), {
              orderBy: vi.fn().mockReturnThis(),
              limit: vi.fn().mockImplementation((n: number) => {
                return Promise.resolve(factRows.slice(0, n));
              }),
              groupBy: vi.fn().mockReturnThis(),
            });
          }

          const clauseStr = extractSqlClauseText(clause);
          let filteredSyncs = syncsRows;
          if (clauseStr.includes("running") || clauseStr.includes("pending")) {
            filteredSyncs = syncsRows.filter(
              (r) => r.status === "running" || r.status === "pending",
            );
          } else if (
            clauseStr.includes("completed") ||
            clauseStr.includes("partial")
          ) {
            filteredSyncs = syncsRows.filter(
              (r) => r.status === "completed" || r.status === "partial",
            );
          }

          return Object.assign(Promise.resolve(filteredSyncs), {
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation((n: number) => {
              return Promise.resolve(filteredSyncs.slice(0, n));
            }),
            groupBy: vi.fn().mockReturnThis(),
          });
        }),
      })),
    })),
  };

  return { syncsRows, factRows, db };
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { GscSearchPerformanceRepository } from "./repositories/GscSearchPerformanceRepository";

// Simulated report builder following the server function logic in searchPerformance.ts
async function buildTestSearchPerformanceReport(params: {
  projectId: string;
  startDate: string;
  endDate: string;
}) {
  const { projectId, startDate, endDate } = params;

  const [hasCoverage, latestSync, activeSync, storedCoverage] =
    await Promise.all([
      GscSearchPerformanceRepository.hasCoverage(projectId, startDate, endDate),
      GscSearchPerformanceRepository.getLatestSyncRun(projectId),
      GscSearchPerformanceRepository.getActiveSyncRun(projectId),
      GscSearchPerformanceRepository.getStoredCoverageRange(projectId),
    ]);

  const syncCoverage = (() => {
    if (!latestSync && !storedCoverage) return null;

    const covStartDate =
      storedCoverage?.startDate ??
      (latestSync?.status === "completed"
        ? latestSync.requestedStartDate
        : (latestSync?.actualLastSuccessfulDate ?? null));
    const covEndDate =
      storedCoverage?.endDate ??
      (latestSync?.status === "completed"
        ? latestSync.requestedEndDate
        : (latestSync?.actualLastSuccessfulDate ?? null));

    let status: "completed" | "partial" | "failed" | "running" = "completed";
    if (activeSync !== null) {
      status = "running";
    } else if (latestSync?.status === "failed") {
      status = "failed";
    } else if (storedCoverage && storedCoverage.endDate < endDate) {
      status = "partial";
    } else if (latestSync?.status === "partial") {
      status = "partial";
    } else if (latestSync?.status === "completed") {
      status = "completed";
    }

    return {
      status,
      startDate: covStartDate,
      endDate: covEndDate,
      rowsFetched: latestSync?.rowsFetched ?? 0,
      rowsInserted: latestSync?.rowsInserted ?? 0,
      isPartialRecent:
        storedCoverage !== null && storedCoverage.endDate < endDate,
    };
  })();

  if (hasCoverage) {
    return {
      connected: true as const,
      source: "database" as const,
      coverage: true as const,
      lastSyncedAt: latestSync?.completedAt ?? null,
      isSyncRunning: activeSync !== null,
      syncCoverage,
      range: {
        startDate,
        endDate,
        prevStartDate: "2026-04-01",
        prevEndDate: "2026-04-30",
      },
      totals: totalsResult,
      prevTotals: totalsResult,
      strikingDistance: strikingResult,
      countries: countriesResult,
    };
  }

  // Live fallback simulation
  return {
    connected: true as const,
    source: "live_fallback" as const,
    coverage: false as const,
    lastSyncedAt: latestSync?.completedAt ?? null,
    isSyncRunning: activeSync !== null,
    syncCoverage,
    range: {
      startDate,
      endDate,
      prevStartDate: "2026-04-01",
      prevEndDate: "2026-04-30",
    },
    totals: totalsResult,
    prevTotals: totalsResult,
    strikingDistance: strikingResult,
    countries: countriesResult,
  };
}

describe("Search Performance Report Flow & Coverage Scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncsRows.length = 0;
    mocks.factRows.length = 0;
  });

  it("1. Existing facts + completed sync history -> source: database, coverage: true", async () => {
    mocks.syncsRows.push({
      status: "completed",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-31",
      actualLastSuccessfulDate: "2026-05-31",
      rowsFetched: 1500,
      rowsInserted: 1500,
      completedAt: "2026-05-31T23:59:59Z",
    });
    mocks.factRows.push({
      minDate: "2026-05-01",
      maxDate: "2026-05-31",
      count: 31,
      totalDays: 31,
    });

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("database");
    expect(report.coverage).toBe(true);
    expect(report.syncCoverage?.status).toBe("completed");
    expect(report.syncCoverage?.startDate).toBe("2026-05-01");
    expect(report.syncCoverage?.endDate).toBe("2026-05-31");
  });

  it("2. Existing facts + partial sync history -> source: live_fallback when range exceeds partial sync, status: partial", async () => {
    mocks.syncsRows.push({
      status: "partial",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-31",
      actualLastSuccessfulDate: "2026-05-20",
      rowsFetched: 800,
      rowsInserted: 800,
      completedAt: "2026-05-20T23:59:59Z",
    });
    mocks.factRows.push({
      minDate: "2026-05-01",
      maxDate: "2026-05-20",
      count: 20,
      totalDays: 20,
    });

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("live_fallback");
    expect(report.coverage).toBe(false);
    expect(report.syncCoverage?.status).toBe("partial");
    expect(report.syncCoverage?.startDate).toBe("2026-05-01");
    expect(report.syncCoverage?.endDate).toBe("2026-05-20");
    expect(report.syncCoverage?.isPartialRecent).toBe(true);
  });

  it("3. Facts with no sync history -> conservative fallback recognizes continuous facts", async () => {
    // 31 continuous days of legacy facts with no sync runs
    mocks.factRows.push({
      minDate: "2025-01-01",
      maxDate: "2025-01-31",
      count: 31,
      totalDays: 31,
    });

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("database");
    expect(report.coverage).toBe(true);
    expect(report.syncCoverage?.startDate).toBe("2025-01-01");
    expect(report.syncCoverage?.endDate).toBe("2025-01-31");
  });

  it("4. Sync history with zero-row intervals -> covered without requiring fake fact rows", async () => {
    // Successfully synchronized interval where no search queries occurred on some days
    mocks.syncsRows.push({
      status: "completed",
      requestedStartDate: "2026-06-01",
      requestedEndDate: "2026-06-10",
      actualLastSuccessfulDate: "2026-06-10",
      rowsFetched: 50,
      rowsInserted: 50,
    });
    // Facts only exist for 3 days because 7 days had zero impressions
    mocks.factRows.push({
      minDate: "2026-06-02",
      maxDate: "2026-06-08",
      count: 3,
      totalDays: 3,
    });

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("database");
    expect(report.coverage).toBe(true);
    expect(report.syncCoverage?.endDate).toBe("2026-06-10");
  });

  it("5. Failed latest sync but older valid coverage -> truthful coverage with failed status", async () => {
    // Completed older sync
    mocks.syncsRows.push(
      {
        status: "failed",
        requestedStartDate: "2026-06-11",
        requestedEndDate: "2026-06-20",
        actualLastSuccessfulDate: null,
        error: "GSC rate limit",
      },
      {
        status: "completed",
        requestedStartDate: "2026-06-01",
        requestedEndDate: "2026-06-10",
        actualLastSuccessfulDate: "2026-06-10",
      },
    );
    mocks.factRows.push({
      minDate: "2026-06-01",
      maxDate: "2026-06-10",
      count: 10,
      totalDays: 10,
    });

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2026-06-01",
      endDate: "2026-06-20",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("live_fallback");
    expect(report.coverage).toBe(false);
    expect(report.syncCoverage?.status).toBe("failed");
    // Truthful stored coverage reflects what was actually synchronized
    expect(report.syncCoverage?.startDate).toBe("2026-06-01");
    expect(report.syncCoverage?.endDate).toBe("2026-06-10");
  });

  it("6. No facts and no sync history -> safe empty report without throwing", async () => {
    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-empty",
      startDate: "2026-06-01",
      endDate: "2026-06-28",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("live_fallback");
    expect(report.coverage).toBe(false);
    expect(report.syncCoverage).toBeNull();
  });

  it("7. Malformed/legacy sync row does not crash the whole report and safely recovers", async () => {
    // Malformed rows (null dates, corrupted bounds, invalid numbers)
    mocks.syncsRows.push(
      {
        status: "completed",
        requestedStartDate: null,
        requestedEndDate: null,
      },
      {
        status: "partial",
        requestedStartDate: "2026-07-10",
        requestedEndDate: "2026-07-01", // inverted
        actualLastSuccessfulDate: null,
      },
      {
        status: "completed",
        requestedStartDate: "2026-07-01",
        requestedEndDate: "2026-07-07",
        actualLastSuccessfulDate: "2026-07-07",
      },
    );

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2026-07-01",
      endDate: "2026-07-07",
    });

    expect(report.connected).toBe(true);
    expect(report.source).toBe("database");
    expect(report.coverage).toBe(true);
    expect(report.syncCoverage?.startDate).toBe("2026-07-01");
    expect(report.syncCoverage?.endDate).toBe("2026-07-07");
  });

  it("8. Search Performance report serialization -> plain JSON-serializable structure", async () => {
    mocks.syncsRows.push({
      status: "completed",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-28",
      actualLastSuccessfulDate: "2026-05-28",
      rowsFetched: 100,
      rowsInserted: 100,
      completedAt: "2026-05-28T12:00:00Z",
    });
    mocks.factRows.push({
      minDate: "2026-05-01",
      maxDate: "2026-05-28",
      count: 28,
      totalDays: 28,
    });

    const report = await buildTestSearchPerformanceReport({
      projectId: "proj-1",
      startDate: "2026-05-01",
      endDate: "2026-05-28",
    });

    // Verify round-trip JSON serialization
    const jsonString = JSON.stringify(report);
    const parsed: unknown = JSON.parse(jsonString);

    expect(parsed).toEqual(report);

    const parsedReport = asRecord(parsed, "serialized report");
    expect(typeof parsedReport["connected"]).toBe("boolean");
    expect(typeof parsedReport["source"]).toBe("string");
    expect(
      typeof asRecord(parsedReport["range"], "serialized range")["startDate"],
    ).toBe("string");
    expect(
      typeof asRecord(parsedReport["totals"], "serialized totals")["clicks"],
    ).toBe("number");
    expect(Array.isArray(parsedReport["strikingDistance"])).toBe(true);
    expect(Array.isArray(parsedReport["countries"])).toBe(true);
  });
});
