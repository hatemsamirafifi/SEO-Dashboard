import { describe, expect, it } from "vitest";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";

interface TrendTestSnapshot {
  runId: string;
  trackingKeywordId: string;
  device: "desktop" | "mobile";
  checkedAt: string;
  position: number | null;
  rankingStatus: "RANKED" | "NO_RESULT" | "CHECK_FAILED" | "NOT_CHECKED" | null;
}

interface TrendTestRun {
  id: string;
  configId: string;
  status: "completed" | "partial" | "failed";
  isSubsetRun: boolean;
  startedAt: string;
}

/**
 * Pure simulation of getConfigTrend query resolution semantics:
 * - Scoped to completed or partial runs for the config
 * - Includes both full and subset runs (e.g. check missing rankings / retry runs)
 * - Evaluates portfolio state as of each check date
 * - Preserves previous known rankings when a check date only covers a subset
 * - Excludes CHECK_FAILED from overwriting known rankings
 */
function simulateConfigTrend(
  configId: string,
  device: "desktop" | "mobile",
  cutoff: string,
  runs: TrendTestRun[],
  snapshots: TrendTestSnapshot[],
) {
  const validRuns = runs.filter(
    (r) =>
      r.configId === configId &&
      (r.status === "completed" || r.status === "partial") &&
      r.startedAt >= cutoff,
  );

  const datesMap = new Map<string, { latestRunAt: string; runId: string }>();
  for (const r of validRuns) {
    const d = r.startedAt.slice(0, 10);
    const existing = datesMap.get(d);
    if (!existing || r.startedAt > existing.latestRunAt) {
      datesMap.set(d, { latestRunAt: r.startedAt, runId: r.id });
    }
  }

  const sortedDates = [...datesMap.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  );

  const results: Array<{
    runId: string;
    checkedAt: string;
    total: number;
    top3: number;
    top4to10: number;
    top11to20: number;
  }> = [];

  const completedRunIds = new Set(
    runs
      .filter(
        (r) =>
          r.configId === configId &&
          (r.status === "completed" || r.status === "partial"),
      )
      .map((r) => r.id),
  );

  for (const [, { latestRunAt, runId }] of sortedDates) {
    // Pick latest valid snapshot per keyword up to latestRunAt
    const validSnaps = snapshots.filter(
      (s) =>
        s.device === device &&
        completedRunIds.has(s.runId) &&
        s.checkedAt <= latestRunAt &&
        (s.rankingStatus === null ||
          (s.rankingStatus !== "CHECK_FAILED" &&
            s.rankingStatus !== "NOT_CHECKED")),
    );

    const latestByKw = new Map<string, TrendTestSnapshot>();
    for (const s of validSnaps) {
      const cur = latestByKw.get(s.trackingKeywordId);
      if (!cur || s.checkedAt > cur.checkedAt) {
        latestByKw.set(s.trackingKeywordId, s);
      }
    }

    let top3 = 0;
    let top4to10 = 0;
    let top11to20 = 0;

    for (const s of latestByKw.values()) {
      if (s.position !== null) {
        if (s.position >= 1 && s.position <= 3) top3++;
        else if (s.position >= 4 && s.position <= 10) top4to10++;
        else if (s.position >= 11 && s.position <= 20) top11to20++;
      }
    }

    results.push({
      runId,
      checkedAt: latestRunAt,
      total: latestByKw.size,
      top3,
      top4to10,
      top11to20,
    });
  }

  return results;
}

describe("rank tracking snapshot queries", () => {
  it("formats comparison cutoffs like SQLite current_timestamp", () => {
    expect(toSqliteTimestamp(new Date("2026-06-09T12:34:56.789Z"))).toBe(
      "2026-06-09 12:34:56",
    );
  });

  it("includes subset runs so missing-rankings checks update the trend chart", () => {
    const configId = "cfg-1";
    const runs: TrendTestRun[] = [
      {
        id: "run-1",
        configId,
        status: "completed",
        isSubsetRun: false,
        startedAt: "2026-10-13 10:00:00",
      },
      // Subsequent check for missing rankings on the next day (subset run)
      {
        id: "run-2",
        configId,
        status: "completed",
        isSubsetRun: true,
        startedAt: "2026-10-14 14:00:00",
      },
    ];

    const snapshots: TrendTestSnapshot[] = [
      // Day 1: kw1 ranked 5, kw2 not ranking
      {
        runId: "run-1",
        trackingKeywordId: "kw1",
        device: "desktop",
        checkedAt: "2026-10-13 10:00:00",
        position: 5,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-1",
        trackingKeywordId: "kw2",
        device: "desktop",
        checkedAt: "2026-10-13 10:00:00",
        position: null,
        rankingStatus: "NO_RESULT",
      },
      // Day 2 (subset check on kw2): kw2 now ranks at position 2
      {
        runId: "run-2",
        trackingKeywordId: "kw2",
        device: "desktop",
        checkedAt: "2026-10-14 14:00:00",
        position: 2,
        rankingStatus: "RANKED",
      },
    ];

    const trend = simulateConfigTrend(
      configId,
      "desktop",
      "2026-10-01 00:00:00",
      runs,
      snapshots,
    );

    expect(trend).toHaveLength(2);
    // Day 1: kw1 in 4-10 (1), kw2 not ranking
    expect(trend[0]).toEqual({
      runId: "run-1",
      checkedAt: "2026-10-13 10:00:00",
      total: 2,
      top3: 0,
      top4to10: 1,
      top11to20: 0,
    });
    // Day 2: subset run updated kw2 to top 3 without dropping kw1
    expect(trend[1]).toEqual({
      runId: "run-2",
      checkedAt: "2026-10-14 14:00:00",
      total: 2,
      top3: 1,
      top4to10: 1,
      top11to20: 0,
    });
  });

  it("does not let CHECK_FAILED snapshots corrupt known positions on a check date", () => {
    const configId = "cfg-1";
    const runs: TrendTestRun[] = [
      {
        id: "run-1",
        configId,
        status: "completed",
        isSubsetRun: false,
        startedAt: "2026-10-13 10:00:00",
      },
      {
        id: "run-2",
        configId,
        status: "partial",
        isSubsetRun: true,
        startedAt: "2026-10-14 12:00:00",
      },
    ];

    const snapshots: TrendTestSnapshot[] = [
      {
        runId: "run-1",
        trackingKeywordId: "kw1",
        device: "desktop",
        checkedAt: "2026-10-13 10:00:00",
        position: 2,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-2",
        trackingKeywordId: "kw1",
        device: "desktop",
        checkedAt: "2026-10-14 12:00:00",
        position: null,
        rankingStatus: "CHECK_FAILED",
      },
    ];

    const trend = simulateConfigTrend(
      configId,
      "desktop",
      "2026-10-01 00:00:00",
      runs,
      snapshots,
    );

    expect(trend).toHaveLength(2);
    // kw1 remains in top 3 on Day 2 because CHECK_FAILED is ignored
    expect(trend[1].top3).toBe(1);
  });
});
