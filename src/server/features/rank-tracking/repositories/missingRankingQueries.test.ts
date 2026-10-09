import { describe, expect, it } from "vitest";
import type { DeviceRankingFacts } from "@/shared/rank-tracking";

interface TestSnapshotRow {
  runId: string;
  trackingKeywordId: string;
  device: string;
  position: number | null;
  previousPosition: number | null;
  rankingStatus: "RANKED" | "NO_RESULT" | "CHECK_FAILED" | null;
  checkedAt: string;
}

interface TestRun {
  id: string;
  configId: string;
  status: "completed" | "partial" | "failed";
}

/**
 * Pure simulation of getLatestRankingFactsForConfig + backfillPreviousPositionsForLostKeywords
 */
function resolveRankingFacts(
  configId: string,
  runs: TestRun[],
  snapshots: TestSnapshotRow[],
): Map<string, DeviceRankingFacts> {
  const result = new Map<string, DeviceRankingFacts>();

  const candidateRunIds = new Set(
    runs
      .filter(
        (r) =>
          r.configId === configId &&
          ["completed", "partial", "failed"].includes(r.status),
      )
      .map((r) => r.id),
  );

  // Group latest by (trackingKeywordId, device)
  const candidateSnaps = snapshots.filter((s) => candidateRunIds.has(s.runId));
  const latestByPair = new Map<string, TestSnapshotRow>();

  for (const s of candidateSnaps) {
    const key = `${s.trackingKeywordId}:${s.device}`;
    const cur = latestByPair.get(key);
    if (!cur || s.checkedAt > cur.checkedAt) {
      latestByPair.set(key, s);
    } else if (s.checkedAt === cur.checkedAt) {
      if (s.rankingStatus === "CHECK_FAILED" && cur.rankingStatus !== "CHECK_FAILED") {
        latestByPair.set(key, s);
      }
    }
  }

  for (const [key, row] of latestByPair.entries()) {
    result.set(key, {
      hasSnapshot: true,
      position: row.position,
      previousPosition: row.previousPosition,
      rankingStatus: row.rankingStatus,
    });
  }

  // Backfill: if position === null && previousPosition == null && rankingStatus !== "CHECK_FAILED"
  const validRunIds = new Set(
    runs
      .filter(
        (r) =>
          r.configId === configId &&
          ["completed", "partial"].includes(r.status),
      )
      .map((r) => r.id),
  );

  for (const [key, fact] of result.entries()) {
    if (
      fact.hasSnapshot &&
      fact.position === null &&
      fact.previousPosition == null &&
      fact.rankingStatus !== "CHECK_FAILED"
    ) {
      const [keywordId, device] = key.split(":");
      const priorRanked = snapshots
        .filter(
          (s) =>
            s.trackingKeywordId === keywordId &&
            s.device === device &&
            validRunIds.has(s.runId) &&
            s.position !== null,
        )
        .toSorted((a, b) => b.checkedAt.localeCompare(a.checkedAt));

      if (priorRanked.length > 0 && typeof priorRanked[0].position === "number") {
        fact.previousPosition = priorRanked[0].position;
      }
    }
  }

  return result;
}

describe("missingRankingQueries lost keyword resolution semantics", () => {
  const configId = "cfg-1";
  const kwLost = "kw-lost";
  const kwNever = "kw-never";

  it("backfills previousPosition when latest check is NO_RESULT but an earlier run had a valid position", () => {
    const runs: TestRun[] = [
      { id: "run-1", configId, status: "partial" },
      { id: "run-2", configId, status: "partial" },
    ];
    const snapshots: TestSnapshotRow[] = [
      {
        runId: "run-1",
        trackingKeywordId: kwLost,
        device: "desktop",
        checkedAt: "2026-09-27 10:00:00",
        position: 28,
        previousPosition: null,
        rankingStatus: "RANKED",
      },
      {
        runId: "run-2",
        trackingKeywordId: kwLost,
        device: "desktop",
        checkedAt: "2026-10-04 10:00:00",
        position: null,
        previousPosition: null, // previously missed due to partial run or multiple checks
        rankingStatus: "NO_RESULT",
      },
      {
        runId: "run-2",
        trackingKeywordId: kwNever,
        device: "desktop",
        checkedAt: "2026-10-04 10:00:00",
        position: null,
        previousPosition: null,
        rankingStatus: "NO_RESULT",
      },
    ];

    const facts = resolveRankingFacts(configId, runs, snapshots);

    // kwLost should have previousPosition backfilled to 28 so it classifies as 'lost'
    const lostFact = facts.get(`${kwLost}:desktop`);
    expect(lostFact).toBeDefined();
    expect(lostFact?.position).toBeNull();
    expect(lostFact?.previousPosition).toBe(28);

    // kwNever never ranked, so previousPosition stays null (classifies as 'no_ranking')
    const neverFact = facts.get(`${kwNever}:desktop`);
    expect(neverFact).toBeDefined();
    expect(neverFact?.position).toBeNull();
    expect(neverFact?.previousPosition).toBeNull();
  });
});
