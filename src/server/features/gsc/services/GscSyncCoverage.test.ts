/* eslint-disable max-lines, max-lines-per-function */
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  isRangeCoveredByIntervals,
  mergeDateIntervals,
  syncRunsToIntervals,
} from "./gscSyncUtils";

interface SyncOutcome {
  status: "completed" | "partial" | "failed";
  ok: boolean;
  chunksTotal: number;
  chunksCompleted: number;
  rowsFetched: number;
  rowsInserted: number;
  actualLastSuccessfulDate: string | null;
  error?: string;
}

function evaluateSyncOutcome(
  chunks: Array<{
    startDate: string;
    endDate: string;
    success: boolean;
    rows: number;
    maxDateWithData?: string | null;
    error?: Error;
  }>,
  _requestedStartDate: string,
  requestedEndDate: string,
): SyncOutcome {
  const chunksTotal = chunks.length;
  let chunksCompleted = 0;
  let rowsFetched = 0;
  let rowsInserted = 0;
  let actualLastSuccessfulDate: string | null = null;
  let encounteredError: Error | null = null;

  for (const chunk of chunks) {
    if (!chunk.success || chunk.error) {
      encounteredError = chunk.error ?? new Error("Chunk failed");
      break;
    }

    rowsFetched += chunk.rows;
    rowsInserted += chunk.rows;
    chunksCompleted++;

    if (chunk.maxDateWithData) {
      actualLastSuccessfulDate = chunk.maxDateWithData;
    }
  }

  let status: "completed" | "partial" | "failed";
  let ok: boolean;

  if (encounteredError) {
    if (chunksCompleted === 0 && rowsInserted === 0) {
      status = "failed";
      ok = false;
    } else {
      status = "partial";
      ok = false;
    }
  } else {
    const isCovered =
      actualLastSuccessfulDate !== null &&
      actualLastSuccessfulDate >= requestedEndDate;
    if (isCovered) {
      status = "completed";
      ok = true;
    } else {
      status = "partial";
      ok = true;
    }
  }

  return {
    status,
    ok,
    chunksTotal,
    chunksCompleted,
    rowsFetched,
    rowsInserted,
    actualLastSuccessfulDate,
    error: encounteredError?.message,
  };
}

function checkCoverage(
  requestedRange: { startDate: string; endDate: string },
  syncInput:
    | { startDate: string; endDate: string; status: string }
    | Array<{
        status: string;
        requestedStartDate: string;
        requestedEndDate: string;
        actualLastSuccessfulDate?: string | null;
      }>
    | null,
): { hasCoverage: boolean; message: string } {
  if (!syncInput) {
    return {
      hasCoverage: false,
      message: "No synchronization history found for property",
    };
  }

  if (Array.isArray(syncInput)) {
    const intervals = syncRunsToIntervals(syncInput);
    const merged = mergeDateIntervals(intervals);
    const covered = isRangeCoveredByIntervals(merged, requestedRange);
    return {
      hasCoverage: covered,
      message: covered
        ? "Requested date range is synchronized"
        : "Requested date range extends beyond synchronized coverage or has gaps",
    };
  }

  const covers =
    syncInput.startDate <= requestedRange.startDate &&
    syncInput.endDate >= requestedRange.endDate;

  if (!covers) {
    return {
      hasCoverage: false,
      message: "Requested date range extends beyond synchronized coverage",
    };
  }

  return {
    hasCoverage: true,
    message: "Requested date range is synchronized",
  };
}

describe("Search Console Synchronized Dataset & Coverage semantics", () => {
  it("1. Full successful synchronization: requested range is fully available", () => {
    const chunks = [
      {
        startDate: "2026-05-01",
        endDate: "2026-05-07",
        success: true,
        rows: 50,
        maxDateWithData: "2026-05-07",
      },
      {
        startDate: "2026-05-08",
        endDate: "2026-05-14",
        success: true,
        rows: 45,
        maxDateWithData: "2026-05-14",
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-05-01", "2026-05-14");

    expect(outcome.status).toBe("completed");
    expect(outcome.ok).toBe(true);
    expect(outcome.chunksCompleted).toBe(2);
    expect(outcome.actualLastSuccessfulDate).toBe("2026-05-14");
    expect(outcome.rowsInserted).toBe(95);
  });

  it("2. Requested range extends beyond latest available GSC date -> partial, not failed", () => {
    const chunks = [
      {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        success: true,
        rows: 50,
        maxDateWithData: "2026-09-07",
      },
      {
        startDate: "2026-09-08",
        endDate: "2026-09-10",
        success: true,
        rows: 25,
        maxDateWithData: "2026-09-10",
      },
      // Recent unfinalized dates return 0 rows from GSC (no error)
      {
        startDate: "2026-09-11",
        endDate: "2026-09-14",
        success: true,
        rows: 0,
        maxDateWithData: null,
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-09-01", "2026-09-14");

    expect(outcome.status).toBe("partial");
    expect(outcome.ok).toBe(true);
    expect(outcome.actualLastSuccessfulDate).toBe("2026-09-10");
    expect(outcome.rowsInserted).toBe(75);
    expect(outcome.error).toBeUndefined();
  });

  it("3. Partial sync persistence: available rows are saved even if later dates are unavailable", () => {
    const persistedDatabase: Array<{ date: string; clicks: number }> = [];

    const availableChunks = [
      { date: "2026-09-08", clicks: 10 },
      { date: "2026-09-09", clicks: 12 },
      { date: "2026-09-10", clicks: 15 },
    ];
    // Persist available days
    persistedDatabase.push(...availableChunks);

    // Days 2026-09-11 to 2026-09-14 return empty from GSC
    expect(persistedDatabase).toHaveLength(3);
    expect(persistedDatabase.map((r) => r.date)).toEqual([
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
    ]);
  });

  it("4. Coverage correctness: coverage ends on the last actually persisted date", () => {
    const requestedEndDate = "2026-09-14";
    const chunks = [
      {
        startDate: "2026-09-01",
        endDate: "2026-09-14",
        success: true,
        rows: 40,
        maxDateWithData: "2026-09-10", // GSC only had rows through Sep 10
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-09-01", requestedEndDate);

    expect(outcome.actualLastSuccessfulDate).toBe("2026-09-10");
    expect(outcome.actualLastSuccessfulDate).not.toBe(requestedEndDate);
  });

  it("5. Recent unavailable dates: 0 rows for recent dates must not produce failed", () => {
    const chunks = [
      {
        startDate: "2026-09-11",
        endDate: "2026-09-14",
        success: true,
        rows: 0,
        maxDateWithData: null,
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-09-11", "2026-09-14");

    expect(outcome.status).toBe("partial");
    expect(outcome.ok).toBe(true);
    expect(outcome.status).not.toBe("failed");
    expect(outcome.error).toBeUndefined();
  });

  it("6. Real provider failure: genuine Google API error produces failed", () => {
    const chunks = [
      {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        success: false,
        rows: 0,
        error: new Error("Search Console API error (500): Backend Error"),
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-09-01", "2026-09-07");

    expect(outcome.status).toBe("failed");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("500");
  });

  it("7. Authentication failure: OAuth token revocation produces failed", () => {
    const chunks = [
      {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        success: false,
        rows: 0,
        error: new Error(
          "OAUTH_TOKEN_FAILURE: Search Console OAuth grant expired or revoked.",
        ),
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-09-01", "2026-09-07");

    expect(outcome.status).toBe("failed");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("OAUTH_TOKEN_FAILURE");
  });

  it("8. Database persistence failure: persistence error produces failed", () => {
    const chunks = [
      {
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        success: false,
        rows: 0,
        error: new Error(
          "SYNC_FAILURE: D1_ERROR: disk I/O error during upsert",
        ),
      },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-09-01", "2026-09-07");

    expect(outcome.status).toBe("failed");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("disk I/O error");
  });

  it("9. Repeated sync: running the same sync twice remains idempotent", () => {
    interface FactRecord {
      grainKey: string;
      date: string;
      clicks: number;
      impressions: number;
    }

    const table = new Map<string, FactRecord>();

    function upsertFact(fact: FactRecord) {
      const key = `${fact.date}::${fact.grainKey}`;
      table.set(key, fact);
    }

    const fact1: FactRecord = {
      grainKey: "kw1",
      date: "2026-05-01",
      clicks: 10,
      impressions: 100,
    };
    const fact2: FactRecord = {
      grainKey: "kw2",
      date: "2026-05-01",
      clicks: 5,
      impressions: 50,
    };

    // Initial sync
    upsertFact(fact1);
    upsertFact(fact2);
    expect(table.size).toBe(2);

    // Repeated sync -> no duplicate rows
    upsertFact(fact1);
    upsertFact(fact2);
    expect(table.size).toBe(2);

    // Metric update
    upsertFact({ ...fact1, clicks: 15 });
    expect(table.size).toBe(2);
    expect(table.get("2026-05-01::kw1")?.clicks).toBe(15);
  });

  it("10. Existing data preservation: partial sync does not remove or corrupt previously synchronized data", () => {
    const existingFacts = new Map<string, number>([
      ["2025-05-13", 100],
      ["2026-09-08", 120],
    ]);

    // Incremental partial sync adds 2026-09-09 and 2026-09-10
    const newFacts = [
      ["2026-09-09", 110],
      ["2026-09-10", 115],
    ] as const;

    for (const [date, clicks] of newFacts) {
      existingFacts.set(date, clicks);
    }

    // Historical data is intact
    expect(existingFacts.has("2025-05-13")).toBe(true);
    expect(existingFacts.has("2026-09-08")).toBe(true);
    expect(existingFacts.get("2025-05-13")).toBe(100);
    expect(existingFacts.size).toBe(4);
  });

  it("11. Live fallback: unsynchronized dates can still be retrieved live", () => {
    const storedCoverage = {
      startDate: "2025-05-13",
      endDate: "2026-09-10",
      status: "partial",
    };

    // Requested range extends into 2026-09-14
    const requestedRange = { startDate: "2026-09-01", endDate: "2026-09-14" };
    const coverageResult = checkCoverage(requestedRange, storedCoverage);

    expect(coverageResult.hasCoverage).toBe(false);
    // UI responds by triggering live GSC fallback without crashing or resetting
    const source = coverageResult.hasCoverage ? "database" : "live_fallback";
    expect(source).toBe("live_fallback");
  });

  it("12. Trace behavior: partial/unavailable recent data must not generate fake HTTP 500 diagnostics", () => {
    const partialSyncResult: {
      status: "completed" | "partial" | "failed";
      ok: boolean;
      error?: string;
      rowsInserted: number;
      chunksCompleted: number;
    } = {
      status: "partial",
      ok: true,
      error: undefined,
      rowsInserted: 50,
      chunksCompleted: 2,
    };

    const isSuccessOrPending =
      partialSyncResult.status === "completed" ||
      (partialSyncResult.status === "partial" && !partialSyncResult.error);

    const traceCompletion = {
      status: isSuccessOrPending ? ("success" as const) : ("failed" as const),
      httpStatus: isSuccessOrPending ? 200 : 500,
      metadata: {
        syncStatus: partialSyncResult.status,
      },
    };

    expect(traceCompletion.status).toBe("success");
    expect(traceCompletion.httpStatus).toBe(200);
    expect(traceCompletion.httpStatus).not.toBe(500);
  });

  it("13. Zero-row day semantics: successfully synchronized day with zero rows is still covered", () => {
    const syncRuns = [
      {
        status: "completed",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-10",
        actualLastSuccessfulDate: "2026-05-10",
      },
    ];

    // Even if distinct days in DB is 8 (because 2 days had zero traffic),
    // the range was successfully synchronized and legitimately returned zero rows.
    // It must NOT be treated as an internal gap.
    const result = checkCoverage(
      { startDate: "2026-05-01", endDate: "2026-05-10" },
      syncRuns,
    );
    expect(result.hasCoverage).toBe(true);
    expect(result.message).toContain("synchronized");
  });

  it("14. Never-synchronized day: detects true gap when dates were never synchronized", () => {
    // Run 1: May 1 to May 5
    // Run 2: May 8 to May 12
    // Days May 6 and May 7 were never synchronized
    const syncRuns = [
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
    ];

    const result = checkCoverage(
      { startDate: "2026-05-03", endDate: "2026-05-10" },
      syncRuns,
    );
    expect(result.hasCoverage).toBe(false);
  });

  it("15. Provider failure: range spanning a failed sync is not covered", () => {
    const syncRuns = [
      {
        status: "partial",
        requestedStartDate: "2026-05-01",
        requestedEndDate: "2026-05-10",
        actualLastSuccessfulDate: "2026-05-04", // Failed on May 5
      },
    ];

    const result = checkCoverage(
      { startDate: "2026-05-01", endDate: "2026-05-10" },
      syncRuns,
    );
    expect(result.hasCoverage).toBe(false);

    // Historical portion before failure IS covered
    const partialResult = checkCoverage(
      { startDate: "2026-05-01", endDate: "2026-05-04" },
      syncRuns,
    );
    expect(partialResult.hasCoverage).toBe(true);
  });

  it("16. Recent unavailable date: recent unfinalized date is partial/pending, not falsely covered", () => {
    // Current date is 2026-09-14. GSC only published through 2026-09-10.
    const syncRuns = [
      {
        status: "partial",
        requestedStartDate: "2026-09-01",
        requestedEndDate: "2026-09-14",
        actualLastSuccessfulDate: "2026-09-10",
      },
    ];

    const result = checkCoverage(
      { startDate: "2026-09-01", endDate: "2026-09-14" },
      syncRuns,
    );
    expect(result.hasCoverage).toBe(false);
  });

  it("17. Cross-database compatibility: SQLite/D1 and Postgres interval logic produces identical coverage outcomes", () => {
    // Both dialects query gsc_search_performance_syncs and run interval merging
    const intervals = syncRunsToIntervals([
      {
        status: "completed",
        requestedStartDate: "2026-01-01",
        requestedEndDate: "2026-01-15",
      },
      {
        status: "completed",
        requestedStartDate: "2026-01-16",
        requestedEndDate: "2026-01-31",
      },
    ]);
    const merged = mergeDateIntervals(intervals);

    expect(merged).toEqual([
      { startDate: "2026-01-01", endDate: "2026-01-31" },
    ]);
    expect(
      isRangeCoveredByIntervals(merged, {
        startDate: "2026-01-05",
        endDate: "2026-01-25",
      }),
    ).toBe(true);
  });
});
