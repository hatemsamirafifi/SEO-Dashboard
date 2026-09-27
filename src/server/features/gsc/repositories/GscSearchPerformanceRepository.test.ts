import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const syncsRows: Array<{
    status: string;
    requestedStartDate: string;
    requestedEndDate: string;
    actualLastSuccessfulDate?: string | null;
  }> = [];

  const factRows: Array<{
    minDate: string | null;
    maxDate: string | null;
    count?: number;
    totalDays?: number;
  }> = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          // Identify table by symbol/name if possible or default to syncsRows
          const isFactTable =
            table &&
            typeof table === "object" &&
            "date" in table &&
            !("requestedStartDate" in table);

          const result = isFactTable ? factRows : syncsRows;
          return Object.assign(Promise.resolve(result), {
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnValue(Promise.resolve(result)),
          });
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  };

  return { syncsRows, factRows, db };
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { GscSearchPerformanceRepository } from "./GscSearchPerformanceRepository";

describe("GscSearchPerformanceRepository coverage & gap detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncsRows.length = 0;
    mocks.factRows.length = 0;
  });

  it("1. successfully synchronized day with rows -> covered", async () => {
    mocks.syncsRows.push({
      status: "completed",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-07",
      actualLastSuccessfulDate: "2026-05-07",
    });

    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-05-01",
      "2026-05-07",
    );

    expect(covered).toBe(true);
  });

  it("2. successfully synchronized day with zero rows -> still covered", async () => {
    // Sync run succeeded completely for 2026-05-01 to 2026-05-07
    // Even if fact rows are 0 (or some days returned 0 rows)
    mocks.syncsRows.push({
      status: "completed",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-07",
      actualLastSuccessfulDate: "2026-05-07",
    });

    // Zero rows in fact table for 2026-05-03:
    // It must NOT be treated as an internal gap!
    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-05-01",
      "2026-05-07",
    );

    expect(covered).toBe(true);
  });

  it("3. never-synchronized day -> gap detected (returns false)", async () => {
    // Run 1 covered 2026-05-01 to 2026-05-05
    // Run 2 covered 2026-05-08 to 2026-05-12
    // Days 2026-05-06 and 2026-05-07 were NEVER synchronized
    mocks.syncsRows.push(
      {
        status: "completed",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-05",
        actualLastSuccessfulDate: "2026-05-05",
      },
      {
        status: "completed",
        requestedStartDate: "2026-05-08",
        requestedEndDate: "2026-05-12",
        actualLastSuccessfulDate: "2026-05-12",
      },
    );

    // Range spanning the un-synchronized gap:
    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-05-03",
      "2026-05-10",
    );

    expect(covered).toBe(false);
  });

  it("4. provider failure on a day/range -> not covered", async () => {
    // Sync run encountered a 500 error on 2026-05-04 and stopped
    mocks.syncsRows.push({
      status: "partial",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-07",
      actualLastSuccessfulDate: "2026-05-03",
    });

    // Querying through 2026-05-07 should report NOT covered
    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-05-01",
      "2026-05-07",
    );

    expect(covered).toBe(false);

    // But querying only up to 2026-05-03 SHOULD be covered
    const partialCovered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-05-01",
      "2026-05-03",
    );

    expect(partialCovered).toBe(true);
  });

  it("5. recent unavailable date -> partial/pending, not falsely covered", async () => {
    // Current date is 2026-09-14. GSC only had data through 2026-09-10.
    // Sync recorded partial up to 2026-09-10.
    mocks.syncsRows.push({
      status: "partial",
      requestedStartDate: "2026-09-01",
      requestedEndDate: "2026-09-14",
      actualLastSuccessfulDate: "2026-09-10",
    });

    // Requested range extends to 2026-09-14
    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-09-01",
      "2026-09-14",
    );

    expect(covered).toBe(false);

    // Synchronized historical portion IS covered
    const historicalCovered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-09-01",
      "2026-09-10",
    );

    expect(historicalCovered).toBe(true);
  });

  it("6. contiguous sync runs merge into seamless continuous coverage", async () => {
    mocks.syncsRows.push(
      {
        status: "completed",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-07",
        actualLastSuccessfulDate: "2026-05-07",
      },
      {
        status: "completed",
        requestedStartDate: "2026-05-08",
        requestedEndDate: "2026-05-14",
        actualLastSuccessfulDate: "2026-05-14",
      },
    );

    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2026-05-03",
      "2026-05-12",
    );

    expect(covered).toBe(true);
  });

  it("7. legacy data fallback: returns true when facts exist for all expected days", async () => {
    // No sync runs, but 16 consecutive days of facts exist for 2025-01-05 to 2025-01-20
    mocks.factRows.push({
      minDate: "2025-01-05",
      maxDate: "2025-01-20",
      count: 16,
    });

    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2025-01-05",
      "2025-01-20",
    );

    expect(covered).toBe(true);

    const outOfBounds = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2024-12-01",
      "2025-01-20",
    );

    expect(outOfBounds).toBe(false);
  });

  it("8. legacy data fallback: returns false when missing days exist without sync metadata (prevents false-positive gap bridging)", async () => {
    // Range is Jan 1 to Jan 31 (31 expected days)
    // Only 2 days have facts (e.g. Jan 1 and Jan 31). Days Jan 2..30 are missing.
    // Without sync runs, we CANNOT verify if missing days were zero-row days or never-synchronized gaps.
    // Conservative fallback must NOT claim continuous coverage across missing days.
    mocks.factRows.push({
      minDate: "2025-01-01",
      maxDate: "2025-01-31",
      count: 2,
    });

    const covered = await GscSearchPerformanceRepository.hasCoverage(
      "p1",
      "2025-01-01",
      "2025-01-31",
    );

    expect(covered).toBe(false);
  });

  it("9. getStoredCoverageRange reflects true sync bounds even if recent days had zero rows", async () => {
    mocks.syncsRows.push({
      status: "completed",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-10",
      actualLastSuccessfulDate: "2026-05-10",
    });

    // Fact table only has rows up to 2026-05-08 because 05-09 and 05-10 had zero traffic
    mocks.factRows.push({
      minDate: "2026-05-01",
      maxDate: "2026-05-08",
      totalDays: 8,
    });

    const range =
      await GscSearchPerformanceRepository.getStoredCoverageRange("p1");

    expect(range).not.toBeNull();
    expect(range?.startDate).toBe("2026-05-01");
    // Truthful end date is 2026-05-10 (from the successful sync interval), not truncated to 2026-05-08
    expect(range?.endDate).toBe("2026-05-10");
    expect(range?.totalDays).toBe(10);
  });

  it("10. database compatibility: gscSearchPerformanceSyncs has identical column structure across SQLite and PostgreSQL", async () => {
    const { getTableColumns } = await import("drizzle-orm");
    const { gscSearchPerformanceSyncs: sqliteSyncs } =
      await import("@/db/gsc.schema");
    const { gscSearchPerformanceSyncs: pgSyncs } =
      await import("@/db/pg/gsc.schema");

    const sqliteCols = Object.keys(getTableColumns(sqliteSyncs)).toSorted();
    const pgCols = Object.keys(getTableColumns(pgSyncs)).toSorted();

    expect(sqliteCols).toEqual(pgCols);
    expect(sqliteCols).toContain("actualLastSuccessfulDate");
    expect(sqliteCols).toContain("requestedStartDate");
    expect(sqliteCols).toContain("requestedEndDate");
    expect(sqliteCols).toContain("status");
  });

  it("11. parseDbDateMs handles SQLite timestamps and ISO strings accurately", () => {
    // SQLite format UTC: "YYYY-MM-DD HH:MM:SS"
    const sqliteTs = "2026-09-26 21:31:05";
    const parsedSqlite = GscSearchPerformanceRepository.parseDbDateMs(sqliteTs);
    expect(parsedSqlite).toBe(Date.parse("2026-09-26T21:31:05Z"));

    // Standard ISO string
    const isoTs = "2026-09-26T21:31:05.000Z";
    const parsedIso = GscSearchPerformanceRepository.parseDbDateMs(isoTs);
    expect(parsedIso).toBe(Date.parse("2026-09-26T21:31:05.000Z"));

    // Null or undefined
    expect(GscSearchPerformanceRepository.parseDbDateMs(null)).toBe(0);
    expect(GscSearchPerformanceRepository.parseDbDateMs(undefined)).toBe(0);
  });

  it("12. isGscSyncStale identifies stale and healthy active runs", () => {
    const now = Date.parse("2026-09-28T00:00:00Z");
    const timeoutMs = 15 * 60 * 1000; // 15 mins

    // Active run updated 5 minutes ago: NOT stale
    const freshRun = {
      startedAt: "2026-09-27 23:50:00",
      updatedAt: "2026-09-27 23:55:00",
    };
    expect(
      GscSearchPerformanceRepository.isGscSyncStale(freshRun, timeoutMs, now),
    ).toBe(false);

    // Run updated 20 minutes ago: STALE
    const staleRun = {
      startedAt: "2026-09-27 23:30:00",
      updatedAt: "2026-09-27 23:35:00",
    };
    expect(
      GscSearchPerformanceRepository.isGscSyncStale(staleRun, timeoutMs, now),
    ).toBe(true);

    // Run with no updatedAt, started 2 days ago: STALE
    const oldRun = {
      startedAt: "2026-09-26 21:31:05",
      updatedAt: null,
    };
    expect(
      GscSearchPerformanceRepository.isGscSyncStale(oldRun, timeoutMs, now),
    ).toBe(true);
  });

  it("13. getActiveSyncRun auto-recovers and marks stale run as failed", async () => {
    const staleRunRow = {
      id: "run-stale-1",
      projectId: "p1",
      property: "https://example.com/",
      status: "running",
      syncType: "manual",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-07",
      actualLastSuccessfulDate: null,
      startedAt: "2026-09-26 21:31:05",
      updatedAt: "2026-09-26 21:31:05",
      rowsFetched: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsFailed: 0,
      successfulUnits: 0,
    };
    mocks.syncsRows.push(staleRunRow);

    // Query active sync run: should detect staleness, mark as failed in DB, and return null
    const active = await GscSearchPerformanceRepository.getActiveSyncRun("p1");

    expect(mocks.db.update).toHaveBeenCalled();
    expect(active).toBeNull();
  });

  it("14. getActiveSyncRun returns active run when it is fresh", async () => {
    const nowIso = new Date().toISOString();
    const freshRunRow = {
      id: "run-fresh-1",
      projectId: "p1",
      property: "https://example.com/",
      status: "running",
      syncType: "manual",
      requestedStartDate: "2026-05-01",
      requestedEndDate: "2026-05-07",
      actualLastSuccessfulDate: null,
      startedAt: nowIso,
      updatedAt: nowIso,
      rowsFetched: 100,
      rowsInserted: 50,
      rowsUpdated: 0,
      rowsFailed: 0,
      successfulUnits: 1,
    };
    mocks.syncsRows.push(freshRunRow);

    const active = await GscSearchPerformanceRepository.getActiveSyncRun("p1");

    expect(active).not.toBeNull();
    expect(active?.id).toBe("run-fresh-1");
  });
});
