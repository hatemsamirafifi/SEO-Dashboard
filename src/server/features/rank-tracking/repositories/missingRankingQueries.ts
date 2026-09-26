import { and, eq, inArray, max, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { rankCheckRuns, rankSnapshots } from "@/db/schema";
import type { DeviceRankingFacts } from "@/shared/rank-tracking";

interface LatestFactRow {
  trackingKeywordId: string;
  device: string;
  position: number | null;
  previousPosition: number | null;
  rankingStatus: "RANKED" | "NO_RESULT" | "CHECK_FAILED" | "NOT_CHECKED" | null;
}

function factFromRow(row: LatestFactRow): DeviceRankingFacts {
  return {
    hasSnapshot: true,
    position: row.position,
    previousPosition: row.previousPosition,
    rankingStatus: row.rankingStatus,
  };
}

/**
 * Server-side pair-facts resolution for the "Check missing rankings" bulk
 * action. Returns the persisted latest-snapshot facts for every
 * (trackingKeywordId, device) pair of a config in set-based queries — no
 * per-keyword history loads, no N+1, and no keyword-level complement that
 * would lose device pair semantics.
 *
 * Semantics match the table's current-state rendering:
 * - Candidate runs include terminal statuses (completed, partial, failed) so
 *   CHECK_FAILED snapshots (which only ever land in failed/partial runs)
 *   surface as "Ranking unavailable" rather than "never checked".
 * - The latest attempt (including CHECK_FAILED) wins per pair; a preserved
 *   historical valid position never overrides the latest attempt's state.
 * - The same pair can tie on checkedAt (two rows written within the same
 *   second, e.g. racing retries or imports). GROUP BY keeps both rows; the
 *   tie is broken deterministically by preferring a CHECK_FAILED row so a
 *   failed retry is never masked by its predecessor.
 */
export async function getLatestRankingFactsForConfig(
  configId: string,
  keywordIds: string[] | null,
): Promise<Map<string, DeviceRankingFacts>> {
  const result = new Map<string, DeviceRankingFacts>();

  const candidateRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["completed", "partial", "failed"]),
      ),
    );

  const baseConditions: SQL[] = [inArray(rankSnapshots.runId, candidateRunIds)];
  if (keywordIds && keywordIds.length > 0) {
    // D1 caps bound parameters at 100 per statement. The id filter appears in
    // both the grouped subquery and the outer query, so chunk by 40 — same
    // pattern as getEarliestSnapshotsForKeywords.
    const CHUNK_SIZE = 40;
    for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
      const chunk = keywordIds.slice(i, i + CHUNK_SIZE);
      const rows = await selectLatestFactRows(
        baseConditions.concat(inArray(rankSnapshots.trackingKeywordId, chunk)),
      );
      collectFacts(rows, result);
    }
    return result;
  }

  const rows = await selectLatestFactRows(baseConditions);
  collectFacts(rows, result);
  return result;
}

async function selectLatestFactRows(
  conditions: SQL[],
): Promise<LatestFactRow[]> {
  const grouped = db
    .select({
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      device: rankSnapshots.device,
      targetCheckedAt: max(rankSnapshots.checkedAt).as("target_checked_at"),
    })
    .from(rankSnapshots)
    .where(and(...conditions))
    .groupBy(rankSnapshots.trackingKeywordId, rankSnapshots.device)
    .as("grouped");

  return db
    .select({
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      device: rankSnapshots.device,
      position: rankSnapshots.position,
      previousPosition: rankSnapshots.previousPosition,
      rankingStatus: rankSnapshots.rankingStatus,
    })
    .from(rankSnapshots)
    .innerJoin(
      grouped,
      and(
        eq(rankSnapshots.trackingKeywordId, grouped.trackingKeywordId),
        eq(rankSnapshots.device, grouped.device),
        eq(rankSnapshots.checkedAt, grouped.targetCheckedAt),
      ),
    )
    .where(and(...conditions))
    .groupBy(
      rankSnapshots.trackingKeywordId,
      rankSnapshots.device,
      rankSnapshots.position,
      rankSnapshots.previousPosition,
      rankSnapshots.rankingStatus,
    );
}

function collectFacts(
  rows: LatestFactRow[],
  result: Map<string, DeviceRankingFacts>,
) {
  for (const row of rows) {
    const key = `${row.trackingKeywordId}:${row.device}`;
    const facts = factFromRow(row);
    const existing = result.get(key);
    if (
      !existing ||
      (existing.rankingStatus === "CHECK_FAILED") !==
        (facts.rankingStatus === "CHECK_FAILED")
    ) {
      // On a checkedAt tie, a CHECK_FAILED row must win: a failed retry
      // would otherwise be masked by its predecessor and the visible
      // "Ranking unavailable" state would never be retried.
      result.set(key, facts);
    }
  }
}
