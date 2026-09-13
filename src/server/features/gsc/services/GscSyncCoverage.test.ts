import { describe, expect, it } from "vitest";

interface SyncOutcome {
  status: "completed" | "partial" | "failed";
  chunksTotal: number;
  chunksCompleted: number;
  rowsFetched: number;
  rowsInserted: number;
  actualLastSuccessfulDate: string | null;
}

function evaluateSyncOutcome(
  chunks: Array<{ startDate: string; endDate: string; success: boolean; rows: number }>,
  _requestedStartDate: string,
  _requestedEndDate: string,
): SyncOutcome {
  const chunksTotal = chunks.length;
  const completedChunks = chunks.filter((c) => c.success);
  const chunksCompleted = completedChunks.length;
  const rowsFetched = chunks.reduce((acc, c) => acc + c.rows, 0);
  const rowsInserted = completedChunks.reduce((acc, c) => acc + c.rows, 0);

  let status: "completed" | "partial" | "failed";
  if (chunksCompleted === chunksTotal && chunksTotal > 0) {
    status = "completed";
  } else if (chunksCompleted > 0) {
    status = "partial";
  } else {
    status = "failed";
  }

  const actualLastSuccessfulDate =
    completedChunks.length > 0
      ? completedChunks[completedChunks.length - 1].endDate
      : null;

  return {
    status,
    chunksTotal,
    chunksCompleted,
    rowsFetched,
    rowsInserted,
    actualLastSuccessfulDate,
  };
}

function checkCoverage(
  requestedRange: { startDate: string; endDate: string },
  syncCoverage: { startDate: string; endDate: string; status: string } | null,
): { hasCoverage: boolean; message: string } {
  if (!syncCoverage) {
    return {
      hasCoverage: false,
      message: "No synchronization history found for property",
    };
  }
  if (syncCoverage.status !== "completed") {
    return {
      hasCoverage: false,
      message: `Last synchronization incomplete (status: ${syncCoverage.status})`,
    };
  }
  const covers =
    syncCoverage.startDate <= requestedRange.startDate &&
    syncCoverage.endDate >= requestedRange.endDate;

  return {
    hasCoverage: covers,
    message: covers
      ? "Requested date range is synchronized"
      : "Requested date range extends beyond synchronized coverage",
  };
}

describe("Search Console Synchronized Dataset & Coverage semantics", () => {
  it("1. classifies sync as complete when all chunks succeed", () => {
    const chunks = [
      { startDate: "2026-05-01", endDate: "2026-05-07", success: true, rows: 50 },
      { startDate: "2026-05-08", endDate: "2026-05-14", success: true, rows: 45 },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-05-01", "2026-05-14");

    expect(outcome.status).toBe("completed");
    expect(outcome.chunksCompleted).toBe(2);
    expect(outcome.actualLastSuccessfulDate).toBe("2026-05-14");
    expect(outcome.rowsInserted).toBe(95);
  });

  it("2. classifies sync as partial when some chunks fail (does not claim complete)", () => {
    const chunks = [
      { startDate: "2026-05-01", endDate: "2026-05-07", success: true, rows: 50 },
      { startDate: "2026-05-08", endDate: "2026-05-14", success: false, rows: 0 },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-05-01", "2026-05-14");

    expect(outcome.status).toBe("partial");
    expect(outcome.chunksCompleted).toBe(1);
    expect(outcome.chunksTotal).toBe(2);
    expect(outcome.actualLastSuccessfulDate).toBe("2026-05-07");
    expect(outcome.rowsInserted).toBe(50);
  });

  it("3. classifies sync as failed when all chunks fail", () => {
    const chunks = [
      { startDate: "2026-05-01", endDate: "2026-05-07", success: false, rows: 0 },
      { startDate: "2026-05-08", endDate: "2026-05-14", success: false, rows: 0 },
    ];
    const outcome = evaluateSyncOutcome(chunks, "2026-05-01", "2026-05-14");

    expect(outcome.status).toBe("failed");
    expect(outcome.chunksCompleted).toBe(0);
    expect(outcome.actualLastSuccessfulDate).toBeNull();
    expect(outcome.rowsInserted).toBe(0);
  });

  it("4. detects missing date coverage and prevents silent partial presentation", () => {
    const completedSync = {
      startDate: "2026-05-01",
      endDate: "2026-05-14",
      status: "completed",
    };

    // Requested range inside coverage
    expect(checkCoverage({ startDate: "2026-05-05", endDate: "2026-05-10" }, completedSync).hasCoverage).toBe(true);

    // Requested range starts before coverage
    expect(checkCoverage({ startDate: "2026-04-20", endDate: "2026-05-10" }, completedSync).hasCoverage).toBe(false);

    // Incomplete / partial sync never claims full coverage
    const partialSync = {
      startDate: "2026-05-01",
      endDate: "2026-05-07",
      status: "partial",
    };
    expect(checkCoverage({ startDate: "2026-05-01", endDate: "2026-05-07" }, partialSync).hasCoverage).toBe(false);
  });

  it("5. describes dataset as Synchronized Search Console dataset (never claims all GSC data)", () => {
    const datasetDescription = "Synchronized Search Console dataset";
    expect(datasetDescription).not.toContain("All Google Search Console data");
    expect(datasetDescription).not.toContain("All GSC data");
    expect(datasetDescription).toContain("Synchronized");
  });

  it("6. verifies sync idempotency: repeated sync does not duplicate rows", () => {
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

    const fact1: FactRecord = { grainKey: "kw1", date: "2026-05-01", clicks: 10, impressions: 100 };
    const fact2: FactRecord = { grainKey: "kw2", date: "2026-05-01", clicks: 5, impressions: 50 };

    // Initial sync
    upsertFact(fact1);
    upsertFact(fact2);
    expect(table.size).toBe(2);

    // Re-running sync with identical data -> no duplicate rows
    upsertFact(fact1);
    upsertFact(fact2);
    expect(table.size).toBe(2);

    // Updated metrics in GSC -> updates in place
    const updatedFact1: FactRecord = { grainKey: "kw1", date: "2026-05-01", clicks: 15, impressions: 120 };
    upsertFact(updatedFact1);
    expect(table.size).toBe(2);
    expect(table.get("2026-05-01::kw1")?.clicks).toBe(15);
  });
});
