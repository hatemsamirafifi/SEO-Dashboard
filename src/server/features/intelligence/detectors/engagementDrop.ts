import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { splitWindows } from "./gscWindows";
import {
  fetchGscJoinRows,
  fetchLandingJoinRows,
  fetchRankHeldRows,
} from "./organicJoin";
import { joinUrlEvidence } from "../services/AnalyticsJoinService";

/**
 * `engagement_drop` (spec 010, C2c): per canonical page whose GA4 engagement
 * rate collapsed while ranking held. Engagement is a ratio-of-sums comparison
 * (never averaged daily rates); the rank-held gate uses corroborated
 * non-worsened rank, and rank absence emits with capped confidence rather
 * than blocking (partialData). GSC rows feed join presence only.
 */

export type EngagementPageRow = {
  /** Canonical page identity (join output key). */
  page: string;
  currentSessions: number;
  previousSessions: number;
  currentEngaged: number;
  previousEngaged: number;
  currentRate: number;
  previousRate: number;
  rankWorsened: boolean | null;
  gscClicks: number | null;
  factIds: string[];
};

export type EngagementDropInput = {
  periodFrom: string;
  periodTo: string;
  previousFrom: string;
  previousTo: string;
  windowDays: number;
  rankAvailable: boolean;
  rows: EngagementPageRow[];
  thresholds: Record<string, string | number | boolean>;
};

function isEngagementRow(value: unknown): value is EngagementPageRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "page" in value &&
    typeof value.page === "string" &&
    "currentRate" in value &&
    typeof value.currentRate === "number" &&
    "previousRate" in value &&
    typeof value.previousRate === "number"
  );
}

export function isEngagementDropInput(
  value: unknown,
): value is EngagementDropInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    value.rows.every(isEngagementRow) &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export async function fetchEngagementDropInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<EngagementDropInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    ctx.organizationId,
  );
  if (!connection) {
    throw new InsufficientCoverageError("engagement_drop: no GA4 connection");
  }
  // Anchor at the latest SUCCESS_*-covered landing date (deterministic —
  // never wall clock).
  const coverage = await Ga4SyncRepository.getGrainCoverage(
    projectId,
    connection.propertyId,
    "landing_pages",
    "2000-01-01",
    "2100-01-01",
  );
  const latestDate = coverage.coveredDates[coverage.coveredDates.length - 1];
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "engagement_drop: no SUCCESS_* landing coverage",
    );
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  const coveredIn = (from: string, to: string): number =>
    coverage.coveredDates.filter((date) => date >= from && date <= to).length;
  for (const window of [current, previous]) {
    if (coveredIn(window.from, window.to) / windowDays < minCoverage) {
      throw new InsufficientCoverageError(
        `engagement_drop: landing SUCCESS_* coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  // Project host lets path-only GA4 rows join full-URL GSC/rank rows (006).
  // Projects without a domain keep path-scoped GA4 rows — honest per the
  // identity contract, never an invented host.
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    ctx.organizationId,
  );
  const [landingRows, gscRows, rank] = await Promise.all([
    fetchLandingJoinRows({
      projectId,
      propertyId: connection.propertyId,
      current,
      previous,
    }),
    fetchGscJoinRows({
      projectId,
      from: previous.from,
      to: current.to,
    }),
    fetchRankHeldRows(projectId),
  ]);
  const joined = joinUrlEvidence({
    ga4: landingRows,
    gsc: gscRows,
    rank: rank.rows,
    ...(project?.domain ? { hostContext: project.domain } : {}),
  });
  const gscFactsByUrl = new Map<string, string[]>();
  for (const row of gscRows) {
    const existing = gscFactsByUrl.get(row.url) ?? [];
    existing.push(...row.factIds);
    gscFactsByUrl.set(row.url, existing);
  }
  return {
    periodFrom: current.from,
    periodTo: current.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    windowDays,
    rankAvailable: rank.available,
    rows: joined
      .filter((row) => row.ga4Engagement !== null)
      .map((row) => ({
        page: row.url,
        currentSessions: row.ga4Sessions?.current ?? 0,
        previousSessions: row.ga4Sessions?.previous ?? 0,
        currentEngaged: row.ga4Engagement?.currentEngagedSessions ?? 0,
        previousEngaged: row.ga4Engagement?.previousEngagedSessions ?? 0,
        currentRate: row.ga4Engagement?.currentRate ?? 0,
        previousRate: row.ga4Engagement?.previousRate ?? 0,
        rankWorsened: row.rankWorsened,
        gscClicks: row.gscClicks,
        factIds: gscFactsByUrl.get(row.url) ?? [],
      })),
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      minSessionsPerWindow: thresholdNumber(
        ctx.thresholds,
        "minSessionsPerWindow",
      ),
      declineRatio: thresholdNumber(ctx.thresholds, "declineRatio"),
      rankHoldRequired: true,
    },
  };
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function detectEngagementDrop(
  ctx: DetectorContext,
  input: EngagementDropInput,
): FindingDraft[] {
  const ratio = thresholdNumber(ctx.thresholds, "declineRatio");
  const sessionFloor = thresholdNumber(ctx.thresholds, "minSessionsPerWindow");
  const findings: FindingDraft[] = [];
  for (const row of input.rows) {
    // Sessions floor on BOTH windows: thin pages never emit (noise guard).
    if (row.currentSessions < sessionFloor) continue;
    if (row.previousSessions < sessionFloor) continue;
    // No baseline rate, no ratio.
    if (row.previousRate <= 0) continue;
    const changeRatio = (row.currentRate - row.previousRate) / row.previousRate;
    // Drops only: engagement growth is not an engagement-drop opportunity.
    if (changeRatio > -ratio) continue;
    // Rank-held gate: a worsened rank means ranking_drop owns this page, not
    // this detector. Rank absent → emit with capped confidence (partialData).
    if (row.rankWorsened === true) continue;
    const rankAbsent = row.rankWorsened === null;
    findings.push({
      entityKey: row.page,
      entity: { page: row.page, scope: "page" },
      explanationFact:
        `Engagement rate for ${row.page} fell ` +
        `${Math.abs(changeRatio * 100).toFixed(1)}% ` +
        `(${formatRate(row.previousRate)} → ${formatRate(row.currentRate)}, ` +
        `${formatInt(row.previousEngaged)}/${formatInt(row.previousSessions)} → ` +
        `${formatInt(row.currentEngaged)}/${formatInt(row.currentSessions)} engaged/sessions) from ` +
        `${input.previousFrom}..${input.previousTo} to ` +
        `${input.periodFrom}..${input.periodTo}` +
        (row.rankWorsened === false ? " while tracked rank held." : "."),
      evidence: {
        metrics: {
          page: row.page,
          rateBefore: row.previousRate,
          rateAfter: row.currentRate,
          changeRatio,
          engagedSessionsBefore: row.previousEngaged,
          engagedSessionsAfter: row.currentEngaged,
          sessionsBefore: row.previousSessions,
          sessionsAfter: row.currentSessions,
          windowDays: input.windowDays,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: row.rankWorsened === false ? ["ga4", "rank"] : ["ga4"],
        sourceRefs: {},
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: rankAbsent ? ["rank_corroboration_absent"] : [],
        confidenceInputs: {
          coverage: 1,
          volume: row.currentSessions,
          magnitude: Math.abs(changeRatio),
          rankHeld: row.rankWorsened === false,
        },
      },
      detectedAt: new Date().toISOString(),
      // Capped confidence when rank corroboration is absent.
      confidenceScore: rankAbsent ? 55 : 70,
      coverageFlags: {
        landingCoverageCurrent: 1,
        landingCoveragePrevious: 1,
      },
    });
  }
  return findings;
}

export const engagementDropDetector: DetectorDef = {
  detectorKey: "engagement_drop",
  version: 1,
  requiredSources: ["ga4"],
  optionalCorroborators: ["rank"],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "ga4", grains: ["landing_pages"], minCoverageRatio: 0.8 },
  ],
  detect: (ctx, input) => {
    if (!isEngagementDropInput(input)) {
      throw new Error("engagement_drop: mistyped input");
    }
    return detectEngagementDrop(ctx, input);
  },
};
