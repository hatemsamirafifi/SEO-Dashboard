import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { addDaysISO } from "./gscWindows";

/**
 * `ranking_drop` (final-plan §4): tracked keywords previously in the top
 * tier that lost ≥ dropPositions. Windows are run pairs (completed, or
 * partial WITH committed snapshots); failed/empty runs never qualify.
 * GSC click agreement raises confidence; GSC absence carries no penalty.
 */

const QUALIFYING_STATUSES = ["completed"];

export type RankDropPair = {
  trackingKeywordId: string;
  keyword: string;
  device: string;
  locationCode: number;
  previousPosition: number;
  currentPosition: number | null;
  previousSnapshotId: number;
  currentSnapshotId: number;
  previousRunAt: string;
  currentRunAt: string;
  url: string | null;
};

export type RankDropInput = {
  pairs: RankDropPair[];
  clicksAgreementByKeyword: Record<string, boolean>;
  gscAvailable: boolean;
  thresholds: Record<string, string | number | boolean>;
};

export function isRankDropInput(value: unknown): value is RankDropInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "pairs" in value &&
    Array.isArray(value.pairs) &&
    "clicksAgreementByKeyword" in value &&
    typeof value.clicksAgreementByKeyword === "object" &&
    value.clicksAgreementByKeyword !== null &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

type RankRun = {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
};

async function qualifyingRunPairs(
  projectId: string,
): Promise<
  Array<{
    configId: string;
    locationCode: number;
    latest: RankRun;
    prior: RankRun;
  }>
> {
  const configs =
    await RankTrackingRepository.getConfigsForProject(projectId);
  const pairs: Array<{
    configId: string;
    locationCode: number;
    latest: RankRun;
    prior: RankRun;
  }> = [];
  for (const config of configs) {
    const runs = await RankTrackingRepository.getRecentRunsForConfig(
      config.id,
      6,
    );
    const qualifying: RankRun[] = [];
    for (const run of runs) {
      if (QUALIFYING_STATUSES.includes(run.status)) {
        qualifying.push(run);
      } else if (run.status === "partial") {
        const snapshots =
          await RankTrackingRepository.getSnapshotsForRun(run.id);
        if (snapshots.length > 0) qualifying.push(run);
      }
      // failed/empty/cancelled/pending/running never qualify — ignored.
      if (qualifying.length >= 2) break;
    }
    if (qualifying.length < 2) continue;
    const [latest, prior] = qualifying as [RankRun, RankRun];
    pairs.push({ configId: config.id, locationCode: config.locationCode, latest, prior });
  }
  return pairs;
}

export async function fetchRankDropInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<RankDropInput> {
  const pairs = await qualifyingRunPairs(projectId);
  if (pairs.length === 0) {
    throw new InsufficientCoverageError(
      "ranking_drop: no config has two runs with committed snapshots",
    );
  }
  const allPairs: RankDropPair[] = [];
  for (const pair of pairs) {
    const [latestSnaps, priorSnaps] = await Promise.all([
      RankTrackingRepository.getSnapshotsForRun(pair.latest.id),
      RankTrackingRepository.getSnapshotsForRun(pair.prior.id),
    ]);
    const usable = (snap: (typeof latestSnaps)[number]) =>
      snap.rankingStatus === "RANKED" || snap.rankingStatus === "NO_RESULT";
    const priorByKey = new Map<string, (typeof priorSnaps)[number]>();
    for (const snap of priorSnaps) {
      if (!usable(snap)) continue;
      priorByKey.set(`${snap.trackingKeywordId}::${snap.device}`, snap);
    }
    for (const snap of latestSnaps) {
      if (!usable(snap)) continue;
      const prior = priorByKey.get(
        `${snap.trackingKeywordId}::${snap.device}`,
      );
      if (!prior || prior.position == null) continue;
      allPairs.push({
        trackingKeywordId: snap.trackingKeywordId,
        keyword: snap.keyword,
        device: snap.device,
        locationCode: pair.locationCode,
        previousPosition: prior.position,
        currentPosition: snap.position,
        previousSnapshotId: prior.id,
        currentSnapshotId: snap.id,
        previousRunAt: pair.prior.startedAt,
        currentRunAt: pair.latest.startedAt,
        url: snap.url,
      });
    }
  }
  // GSC click corroboration for the same entities (28d windows anchored at
  // latest GSC facts). GSC absent → unavailable, no penalty.
  const clicksAgreementByKeyword: Record<string, boolean> = {};
  let gscAvailable = false;
  try {
    const latestDate =
      await GscSearchPerformanceRepository.getLatestFactDate(
        projectId,
        "query",
      );
    if (latestDate) {
      gscAvailable = true;
      const from = addDaysISO(latestDate, -55);
      const rows =
        await GscSearchPerformanceRepository.getDailyGrainFacts(
          projectId,
          "query",
          from,
          latestDate,
        );
      const midpoint = addDaysISO(latestDate, -28);
      const sums = new Map<string, { recent: number; older: number }>();
      for (const row of rows) {
        const key = (row.query ?? row.grainKey).toLowerCase();
        const entry = sums.get(key) ?? { recent: 0, older: 0 };
        if (row.date > midpoint) entry.recent += row.clicks;
        else entry.older += row.clicks;
        sums.set(key, entry);
      }
      for (const [key, entry] of sums) {
        if (entry.older > 0 && entry.recent < entry.older) {
          clicksAgreementByKeyword[key] = true;
        }
      }
    }
  } catch {
    gscAvailable = false;
  }
  return {
    pairs: allPairs,
    clicksAgreementByKeyword,
    gscAvailable,
    thresholds: {
      dropPositions: thresholdNumber(ctx.thresholds, "dropPositions"),
      topNTier: thresholdNumber(ctx.thresholds, "topNTier"),
    },
  };
}

export function detectRankingDrop(
  ctx: DetectorContext,
  input: RankDropInput,
): FindingDraft[] {
  const dropPositions = thresholdNumber(ctx.thresholds, "dropPositions");
  const topNTier = thresholdNumber(ctx.thresholds, "topNTier");
  const findings: FindingDraft[] = [];
  for (const pair of input.pairs) {
    // Only entities that held a top-tier position can "drop".
    if (pair.previousPosition > topNTier) continue;
    // NO_RESULT (null) means out of the index: worst-case position 101.
    const current = pair.currentPosition ?? 101;
    const drop = current - pair.previousPosition;
    if (drop < dropPositions) continue;
    const keywordKey = pair.keyword.toLowerCase();
    const agrees = input.clicksAgreementByKeyword[keywordKey] === true;
    const entityKey = `${keywordKey}::${pair.device}::${pair.locationCode}`;
    findings.push({
      entityKey,
      entity: {
        keyword: pair.keyword,
        device: pair.device,
        locationCode: pair.locationCode,
        url: pair.url ?? undefined,
      },
      explanationFact:
        `Keyword "${pair.keyword}" (${pair.device}) fell from position ` +
        `${pair.previousPosition} to ${pair.currentPosition ?? "outside the top 100"} ` +
        `between ${pair.previousRunAt.slice(0, 10)} and ${pair.currentRunAt.slice(0, 10)}` +
        `${agrees ? ", with matching click declines" : ""}.`,
      evidence: {
        metrics: {
          positionBefore: pair.previousPosition,
          positionAfter: pair.currentPosition ?? 101,
          dropPositions: drop,
        },
        periods: {
          from: pair.previousRunAt.slice(0, 10),
          to: pair.currentRunAt.slice(0, 10),
        },
        sources: ["rank"],
        sourceRefs: {
          rankSnapshotIds: [pair.previousSnapshotId, pair.currentSnapshotId],
        },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: input.gscAvailable ? [] : ["gsc_corroboration_unavailable"],
        confidenceInputs: { gscClicksAgree: agrees },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: agrees ? 75 : 60,
      coverageFlags: { qualifyingRunPair: true },
    });
  }
  return findings;
}

export const rankingDropDetector: DetectorDef = {
  detectorKey: "ranking_drop",
  version: 1,
  requiredSources: ["rank"],
  optionalCorroborators: ["gsc"],
  minConfidenceToEmit: 40,
  coverage: [{ source: "rank", grains: ["snapshot"], minCoverageRatio: 1 }],
  detect: (ctx, input) => {
    if (!isRankDropInput(input)) {
      throw new Error("ranking_drop: mistyped input");
    }
    return detectRankingDrop(ctx, input);
  },
};
