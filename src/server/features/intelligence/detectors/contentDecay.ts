import { canonicalUrl } from "@/shared/intelligence";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import {
  consecutiveWindows,
  coverageRatio,
  type GscWindow,
} from "./gscWindows";

/**
 * `content_decay` (final-plan §4): pages with large sustained click declines
 * over consecutive windows. Rank corroboration (same-URL position worsening)
 * and GA4 session corroboration (same-URL session declines) lift confidence;
 * without any agreement on a large sustained delta, confidence caps at
 * Medium. Truncated/low-volume entities are excluded per-entity, never as
 * whole-detector skips.
 */

export type DecayPageRow = {
  page: string;
  windows: Array<{ clicks: number; impressions: number; days: number }>;
  factIds: string[];
};

export type DecayInput = {
  periodFrom: string;
  periodTo: string;
  windowDays: number;
  expectedDays: number;
  rows: DecayPageRow[];
  rankAgreementByUrl: Record<string, boolean>;
  rankAvailable: boolean;
  ga4AgreementByUrl: Record<string, boolean>;
  ga4Available: boolean;
  thresholds: Record<string, string | number | boolean>;
};

export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isDecayInput(value: unknown): value is DecayInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "rankAgreementByUrl" in value &&
    typeof value.rankAgreementByUrl === "object" &&
    value.rankAgreementByUrl !== null &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

/**
 * GA4 session corroboration leg (PR10): matching per-URL session declines
 * over the two recent windows. Unconnected, under-covered, or erroring
 * projects degrade (unavailable + note) — corroboration never throws.
 */
async function fetchGa4SessionAgreement(input: {
  projectId: string;
  organizationId: string;
  current: GscWindow;
  previous: GscWindow;
  windowDays: number;
  minCoverage: number;
}): Promise<{ available: boolean; agreementByUrl: Record<string, boolean> }> {
  const unavailable = { available: false, agreementByUrl: {} };
  try {
    const connection = await Ga4ConnectionRepository.getByProjectId(
      input.projectId,
      input.organizationId,
    );
    if (!connection) return unavailable;
    const coverage = await Ga4SyncRepository.getGrainCoverage(
      input.projectId,
      connection.propertyId,
      "landing_pages",
      input.previous.from,
      input.current.to,
    );
    const coveredIn = (from: string, to: string): number =>
      coverage.coveredDates.filter((date) => date >= from && date <= to)
        .length;
    if (
      coveredIn(input.current.from, input.current.to) / input.windowDays <
        input.minCoverage ||
      coveredIn(input.previous.from, input.previous.to) / input.windowDays <
        input.minCoverage
    ) {
      return unavailable;
    }
    const [currentGroups, previousGroups] = await Promise.all([
      Ga4SyncRepository.getLandingGroups(
        input.projectId,
        connection.propertyId,
        input.current.from,
        input.current.to,
        { limit: 500 },
      ),
      Ga4SyncRepository.getLandingGroups(
        input.projectId,
        connection.propertyId,
        input.previous.from,
        input.previous.to,
        { limit: 500 },
      ),
    ]);
    const previousByUrl = new Map<string, number>();
    for (const group of previousGroups) {
      previousByUrl.set(canonicalUrl(group.landingPage), group.sessions);
    }
    const agreementByUrl: Record<string, boolean> = {};
    for (const group of currentGroups) {
      const key = canonicalUrl(group.landingPage);
      const older = previousByUrl.get(key) ?? 0;
      if (older > 0 && group.sessions < older) {
        agreementByUrl[key] = true;
      }
    }
    return { available: true, agreementByUrl };
  } catch {
    return unavailable;
  }
}

export async function fetchDecayInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<DecayInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "page",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError("content_decay: no GSC page facts");
  }
  // Three consecutive windows: current + two predecessors for persistence.
  const [current, previous, oldest] = consecutiveWindows(
    latestDate,
    windowDays,
    3,
  );
  if (!current || !previous || !oldest) {
    throw new Error("content_decay: window construction failed");
  }
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "page",
    oldest.from,
    current.to,
  );
  for (const window of [current, previous, oldest]) {
    if (coverageRatio(rows, window) < minCoverage) {
      throw new InsufficientCoverageError(
        `content_decay: page coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  const byPage = new Map<
    string,
    {
      windows: Array<{ clicks: number; impressions: number; days: number }>;
      factIds: string[];
    }
  >();
  const windows = [current, previous, oldest];
  for (const row of rows) {
    if (!row.page) continue;
    // Canonical page identity: UTM/query variants of one page collapse to
    // one entity, agreeing with technical keys and opportunity keys.
    const page = canonicalUrl(row.page);
    const index = windows.findIndex(
      (window) => row.date >= window.from && row.date <= window.to,
    );
    if (index === -1) continue;
    let entry = byPage.get(page);
    if (!entry) {
      entry = {
        windows: windows.map(() => ({ clicks: 0, impressions: 0, days: 0 })),
        factIds: [],
      };
      byPage.set(page, entry);
    }
    const bucket = entry.windows[index];
    if (!bucket) continue;
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.days += 1;
    if (entry.factIds.length < 200) entry.factIds.push(row.id);
  }
  // Rank corroboration: same-URL average position worsened between the two
  // most recent qualifying runs. Rank unconfigured → unavailable, no penalty.
  const rankAgreementByUrl: Record<string, boolean> = {};
  let rankAvailable = false;
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  for (const config of configs) {
    const runs = await RankTrackingRepository.getRecentRunsForConfig(
      config.id,
      5,
    );
    const qualifying: typeof runs = [];
    for (const run of runs) {
      if (run.status === "completed") {
        qualifying.push(run);
      } else if (run.status === "partial") {
        const snapshots = await RankTrackingRepository.getSnapshotsForRun(
          run.id,
        );
        if (snapshots.length > 0) qualifying.push(run);
      }
      if (qualifying.length >= 2) break;
    }
    if (qualifying.length < 2) continue;
    const [latest, prior] = qualifying;
    if (!latest || !prior) continue;
    const [latestSnaps, priorSnaps] = await Promise.all([
      RankTrackingRepository.getSnapshotsForRun(latest.id),
      RankTrackingRepository.getSnapshotsForRun(prior.id),
    ]);
    const priorByUrl = new Map<string, number[]>();
    for (const snap of priorSnaps) {
      if (snap.url == null || snap.position == null) continue;
      const key = canonicalUrl(snap.url);
      const list = priorByUrl.get(key) ?? [];
      list.push(snap.position);
      priorByUrl.set(key, list);
    }
    const latestByUrl = new Map<string, number[]>();
    for (const snap of latestSnaps) {
      if (snap.url == null || snap.position == null) continue;
      const key = canonicalUrl(snap.url);
      const list = latestByUrl.get(key) ?? [];
      list.push(snap.position);
      latestByUrl.set(key, list);
    }
    for (const [url, latestPositions] of latestByUrl) {
      const priorPositions = priorByUrl.get(url);
      if (!priorPositions || priorPositions.length === 0) continue;
      rankAvailable = true;
      if (average(latestPositions) > average(priorPositions)) {
        rankAgreementByUrl[url] = true;
      }
    }
  }
  const { available: ga4Available, agreementByUrl: ga4AgreementByUrl } =
    await fetchGa4SessionAgreement({
      projectId,
      organizationId: ctx.organizationId,
      current,
      previous,
      windowDays,
      minCoverage,
    });
  return {
    periodFrom: current.from,
    periodTo: current.to,
    windowDays,
    expectedDays: windowDays,
    rows: [...byPage.entries()].map(([page, entry]) => ({
      page,
      windows: entry.windows,
      factIds: entry.factIds,
    })),
    rankAgreementByUrl,
    rankAvailable,
    ga4AgreementByUrl,
    ga4Available,
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      declineRatio: thresholdNumber(ctx.thresholds, "declineRatio"),
      minVolume: thresholdNumber(ctx.thresholds, "minVolume"),
    },
  };
}

export function detectDecay(
  ctx: DetectorContext,
  input: DecayInput,
): FindingDraft[] {
  const declineRatio = thresholdNumber(ctx.thresholds, "declineRatio");
  const minVolume = thresholdNumber(ctx.thresholds, "minVolume");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const findings: FindingDraft[] = [];
  for (const row of input.rows) {
    // Canonicalize defensively: fetchers pre-canonicalize, but direct
    // callers (tests, future composers) may pass raw URLs.
    const page = canonicalUrl(row.page);
    const [current, previous, oldest] = row.windows;
    if (!current || !previous || !oldest) continue;
    // Truncated entities excluded per-entity: day presence below the ratio
    // in any window means the windows are not comparable for this page.
    const dayRatio = Math.min(
      current.days / input.expectedDays,
      previous.days / input.expectedDays,
      oldest.days / input.expectedDays,
    );
    if (dayRatio < minCoverage) continue;
    // Volume floor suppresses (not skips): thin pages cannot decay.
    if (
      previous.clicks < minVolume ||
      oldest.clicks < 1 ||
      current.clicks < 1
    ) {
      continue;
    }
    const recentDecline = (current.clicks - previous.clicks) / previous.clicks;
    const olderDecline = (previous.clicks - oldest.clicks) / oldest.clicks;
    // Sustained: current decline past the ratio AND same direction before.
    if (recentDecline > -declineRatio || olderDecline > 0) continue;
    const rankAgrees = input.rankAgreementByUrl[page] ?? false;
    const ga4Agrees = input.ga4AgreementByUrl[page] ?? false;
    const largeSustained = recentDecline <= -0.5;
    let confidence = 55;
    if (rankAgrees || ga4Agrees) confidence += 15;
    if (largeSustained && (rankAgrees || ga4Agrees)) confidence += 10;
    // Medium cap unless a large sustained delta carries corroboration
    // from rank, GA4 sessions, or both.
    if (!(largeSustained && (rankAgrees || ga4Agrees))) {
      confidence = Math.min(confidence, 69);
    }
    const partialData: string[] = [];
    if (!input.rankAvailable)
      partialData.push("rank_corroboration_unavailable");
    if (!input.ga4Available) partialData.push("ga4_corroboration_unavailable");
    const corroborationNote =
      rankAgrees && ga4Agrees
        ? ", confirmed by ranking declines with matching GA4 session declines"
        : rankAgrees
          ? ", confirmed by ranking declines"
          : ga4Agrees
            ? ", with matching GA4 session declines"
            : "";
    findings.push({
      entityKey: page,
      entity: { page },
      explanationFact:
        `Page ${page} lost ${Math.abs(recentDecline * 100).toFixed(1)}% of clicks ` +
        `(${previous.clicks.toLocaleString("en-US")} → ${current.clicks.toLocaleString("en-US")}) ` +
        `from ${input.periodFrom}..${input.periodTo} vs the prior ${input.windowDays} days, ` +
        `declining for two consecutive windows${corroborationNote}.`,
      evidence: {
        metrics: {
          clicksCurrent: current.clicks,
          clicksPrevious: previous.clicks,
          clicksOldest: oldest.clicks,
          declineRatio: recentDecline,
          olderDecline,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: ga4Agrees ? ["gsc", "ga4"] : ["gsc"],
        sourceRefs: { gscFactIds: row.factIds },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData,
        confidenceInputs: {
          coverageDayRatio: dayRatio,
          rankAgrees,
          ga4Agrees,
          largeSustained,
          baselineVolume: previous.clicks,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: Math.min(confidence, 100),
      coverageFlags: { pageCoverageDayRatio: dayRatio },
    });
  }
  return findings;
}

export const contentDecayDetector: DetectorDef = {
  detectorKey: "content_decay",
  version: 1,
  requiredSources: ["gsc"],
  optionalCorroborators: ["rank", "ga4"],
  minConfidenceToEmit: 40,
  coverage: [{ source: "gsc", grains: ["page"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isDecayInput(input)) {
      throw new Error("content_decay: mistyped input");
    }
    return detectDecay(ctx, input);
  },
};
