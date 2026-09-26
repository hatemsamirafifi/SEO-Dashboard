import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";

/**
 * `backlink_change` (final-plan §4): two-point diff of stored backlink
 * summary snapshots inside the freshness window. Ships as a LABELED
 * heuristic (history-based promotion deferred pending observed noise):
 * confidence capped Medium, `two_point_heuristic` in partialData.
 */

export type BacklinkTotals = {
  backlinks: number | null;
  referringDomains: number | null;
  brokenBacklinks: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
};

export type BacklinkChangeInput = {
  domain: string;
  before: BacklinkTotals;
  after: BacklinkTotals;
  beforeCapturedAt: string;
  afterCapturedAt: string;
  thresholds: Record<string, string | number | boolean>;
};

export function isBacklinkChangeInput(
  value: unknown,
): value is BacklinkChangeInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "domain" in value &&
    typeof value.domain === "string" &&
    "before" in value &&
    typeof value.before === "object" &&
    value.before !== null &&
    "after" in value &&
    typeof value.after === "object" &&
    value.after !== null &&
    "beforeCapturedAt" in value &&
    typeof value.beforeCapturedAt === "string" &&
    "afterCapturedAt" in value &&
    typeof value.afterCapturedAt === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

type BacklinkSnapshotRow = Awaited<
  ReturnType<typeof BacklinkSnapshotRepository.getRecentForProject>
>[number];

function totalsOf(snap: BacklinkSnapshotRow): BacklinkTotals {
  return {
    backlinks: snap.backlinks,
    referringDomains: snap.referringDomains,
    brokenBacklinks: snap.brokenBacklinks,
    newBacklinks: snap.newBacklinks,
    lostBacklinks: snap.lostBacklinks,
    newReferringDomains: snap.newReferringDomains,
    lostReferringDomains: snap.lostReferringDomains,
  };
}

export async function fetchBacklinkChangeInput(
  projectId: string,
  ctx: DetectorContext,
  nowMs: number = Date.now(),
): Promise<BacklinkChangeInput> {
  const freshnessDays = thresholdNumber(ctx.thresholds, "freshnessDays");
  const snapshots = await BacklinkSnapshotRepository.getRecentForProject(
    projectId,
    2,
  );
  if (snapshots.length < 2) {
    throw new InsufficientCoverageError(
      "backlink_change: fewer than 2 snapshots",
    );
  }
  const [after, before] = snapshots;
  if (!after || !before) {
    throw new InsufficientCoverageError(
      "backlink_change: fewer than 2 snapshots",
    );
  }
  const ageMs = nowMs - Date.parse(after.capturedAt);
  if (!Number.isFinite(ageMs) || ageMs > freshnessDays * 86_400_000) {
    throw new InsufficientCoverageError(
      `backlink_change: newest snapshot older than ${freshnessDays}d`,
    );
  }
  return {
    domain: after.domain,
    before: totalsOf(before),
    after: totalsOf(after),
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    thresholds: {
      minSnapshots: thresholdNumber(ctx.thresholds, "minSnapshots"),
      freshnessDays,
    },
  };
}

function delta(after: number | null, before: number | null): number | null {
  if (after == null || before == null) return null;
  return after - before;
}

export function detectBacklinkChange(
  _ctx: DetectorContext,
  input: BacklinkChangeInput,
): FindingDraft[] {
  // Two-point diff needs no injected thresholds at detect time; the
  // freshness/min-snapshot thresholds gate at fetch time and echo below.
  const movement =
    (input.after.newBacklinks ?? 0) +
    (input.after.lostBacklinks ?? 0) +
    (input.after.newReferringDomains ?? 0) +
    (input.after.lostReferringDomains ?? 0);
  // Valid zero input: no movement, no finding — never a failure.
  if (movement <= 0) return [];
  const dRef = delta(
    input.after.referringDomains,
    input.before.referringDomains,
  );
  const dLinks = delta(input.after.backlinks, input.before.backlinks);
  return [
    {
      entityKey: `backlinks:${input.domain}`,
      entity: { domain: input.domain },
      explanationFact:
        `Heuristic (two snapshots): ${input.domain} changed from ` +
        `${input.before.referringDomains ?? "?"} to ${input.after.referringDomains ?? "?"} referring domains ` +
        `(${input.after.newReferringDomains ?? 0} gained, ${input.after.lostReferringDomains ?? 0} lost) ` +
        `between ${input.beforeCapturedAt.slice(0, 10)} and ${input.afterCapturedAt.slice(0, 10)}.`,
      evidence: {
        metrics: {
          // -1 sentinel = total unknown (deltas carry the movement signal).
          referringDomainsBefore: input.before.referringDomains ?? -1,
          referringDomainsAfter: input.after.referringDomains ?? -1,
          referringDomainsDelta: dRef ?? 0,
          backlinksDelta: dLinks ?? 0,
          newBacklinks: input.after.newBacklinks ?? 0,
          lostBacklinks: input.after.lostBacklinks ?? 0,
          newReferringDomains: input.after.newReferringDomains ?? 0,
          lostReferringDomains: input.after.lostReferringDomains ?? 0,
        },
        periods: {
          from: input.beforeCapturedAt.slice(0, 10),
          to: input.afterCapturedAt.slice(0, 10),
        },
        sources: ["backlinks"],
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: ["two_point_heuristic"],
        confidenceInputs: { snapshotCount: 2, movement },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: 50,
      coverageFlags: { twoSnapshots: true },
    },
  ];
}

export const backlinkChangeDetector: DetectorDef = {
  detectorKey: "backlink_change",
  version: 1,
  requiredSources: ["backlinks"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "backlinks", grains: ["snapshot"], minCoverageRatio: 1 },
  ],
  detect: (ctx, input) => {
    if (!isBacklinkChangeInput(input)) {
      throw new Error("backlink_change: mistyped input");
    }
    return detectBacklinkChange(ctx, input);
  },
};
