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
});
