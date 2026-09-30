import {
  STRIKING_DISTANCE_MAX_POSITION,
  STRIKING_DISTANCE_MIN_POSITION,
  canonicalKeyword,
} from "@/shared/intelligence";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { coverageRatio, splitWindows, type GscWindow } from "./gscWindows";

/**
 * `striking_distance` (spec 004): queries whose best position sits in the
 * 11–20 quick-win band — page-one-adjacent, above an impression floor. Band
 * constants are the single shared definition (`shared/intelligence.ts`); the
 * GSC near-miss helper keeps its broader 5..20 dashboard band as a documented
 * superset. Pure detection over pre-fetched GSC query grain; GA4 is NOT a
 * corroborator; rank corroboration is optional evidence only — its absence
 * never blocks emission.
 */

export type StrikingDistanceRow = {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  days: number;
  previousPosition: number | null;
  factIds: string[];
};

export type StrikingDistanceInput = {
  periodFrom: string;
  periodTo: string;
  rows: StrikingDistanceRow[];
  thresholds: Record<string, string | number | boolean>;
};

export function isStrikingDistanceInput(
  value: unknown,
): value is StrikingDistanceInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

/** One observed row per query (best page). Query grain already collapses
 *  per-page rows to per-query rows, so each grain fact is one query-day.
 *  Rank corroboration is read opportunistically; a failure or absence only
 *  downgrades evidence (partialData), never blocks. */
export async function fetchStrikingDistanceInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<StrikingDistanceInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "query",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "striking_distance: no GSC query facts",
    );
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "query",
    previous.from,
    current.to,
  );
  // Stability gate: BOTH windows must be covered at the grain level before
  // the detector is invoked — incomplete coverage skips with a reason
  // (never half-emits, never zero-fills).
  for (const window of [current, previous] as GscWindow[]) {
    if (coverageRatio(rows, window) < minCoverage) {
      throw new InsufficientCoverageError(
        `striking_distance: query coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  const byQuery = new Map<
    string,
    {
      impressions: number;
      clicks: number;
      position: number;
      previousPosition: number;
      days: number;
      factIds: string[];
    }
  >();
  for (const row of rows) {
    const query = canonicalKeyword(row.query ?? row.grainKey);
    const inCurrent = row.date >= current.from && row.date <= current.to;
    if (!inCurrent) continue;
    const existing = byQuery.get(query) ?? {
      impressions: 0,
      clicks: 0,
      position: 0,
      previousPosition: 0,
      days: 0,
      factIds: [],
    };
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.position += row.position * row.impressions;
    existing.days += 1;
    if (existing.factIds.length < 200) existing.factIds.push(row.id);
    byQuery.set(query, existing);
  }
  // Previous-window weighted position per query for movement evidence.
  const previousByQuery = new Map<string, number>();
  const previousWeight = new Map<string, number>();
  for (const row of rows) {
    if (row.date < previous.from || row.date > previous.to) continue;
    const query = canonicalKeyword(row.query ?? row.grainKey);
    previousByQuery.set(
      query,
      (previousByQuery.get(query) ?? 0) + row.position * row.impressions,
    );
    previousWeight.set(
      query,
      (previousWeight.get(query) ?? 0) + row.impressions,
    );
  }
  return {
    periodFrom: current.from,
    periodTo: current.to,
    rows: [...byQuery.entries()].map(([query, entry]) => {
      const weight = previousWeight.get(query) ?? 0;
      return {
        query,
        impressions: entry.impressions,
        clicks: entry.clicks,
        position: entry.impressions > 0 ? entry.position / entry.impressions : 0,
        days: entry.days,
        previousPosition:
          weight > 0 ? (previousByQuery.get(query) ?? 0) / weight : null,
        factIds: entry.factIds,
      };
    }),
    thresholds: {
      minWindowDays: windowDays,
      minImpressions: thresholdNumber(ctx.thresholds, "minImpressions"),
      minPosition: STRIKING_DISTANCE_MIN_POSITION,
      maxPosition: STRIKING_DISTANCE_MAX_POSITION,
    },
  };
}

export function detectStrikingDistance(
  ctx: DetectorContext,
  input: StrikingDistanceInput,
): FindingDraft[] {
  const minImpressions = thresholdNumber(ctx.thresholds, "minImpressions");
  const minPosition = thresholdNumber(ctx.thresholds, "minPosition");
  const maxPosition = thresholdNumber(ctx.thresholds, "maxPosition");
  const findings: FindingDraft[] = [];
  for (const row of input.rows) {
    // Insufficient-data negative: below-floor impressions never emit noise.
    if (row.impressions < minImpressions) continue;
    if (row.position < minPosition || row.position > maxPosition) continue;
    const impressionsLabel = row.impressions.toLocaleString("en-US");
    findings.push({
      entityKey: row.query,
      entity: { query: row.query },
      explanationFact:
        `Query "${row.query}" shows potential at position ` +
        `${row.position.toFixed(1)} with ${impressionsLabel} impressions ` +
        `over ${input.periodFrom}..${input.periodTo}` +
        (row.previousPosition !== null
          ? ` (previously ${row.previousPosition.toFixed(1)}).`
          : "."),
      evidence: {
        metrics: {
          position: row.position,
          impressions: row.impressions,
          clicks: row.clicks,
          ...(row.previousPosition !== null
            ? { previousPosition: row.previousPosition }
            : {}),
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: ["gsc"],
        sourceRefs: { gscFactIds: row.factIds },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: {
          coverageDays: row.days,
          impressionMultiple: row.impressions / minImpressions,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: 65,
      coverageFlags: { queryCoverageDays: row.days },
    });
  }
  return findings;
}

export const strikingDistanceDetector: DetectorDef = {
  detectorKey: "striking_distance",
  version: 1,
  requiredSources: ["gsc"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [{ source: "gsc", grains: ["query"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isStrikingDistanceInput(input)) {
      throw new Error("striking_distance: mistyped input");
    }
    return detectStrikingDistance(ctx, input);
  },
};