import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { canonicalKeyword } from "@/shared/intelligence";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { coverageRatio, splitWindows, type GscWindow } from "./gscWindows";

/**
 * `low_ctr_query` (final-plan §4): queries with strong visibility but weak
 * clicks — position band + impression floor, CTR below floor. GA4 is
 * explicitly NOT a corroborator: its absence never affects this detector.
 */

export type LowCtrQueryRow = {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  days: number;
  factIds: string[];
};

export type LowCtrInput = {
  periodFrom: string;
  periodTo: string;
  rows: LowCtrQueryRow[];
  windowDays: number;
  thresholds: Record<string, string | number | boolean>;
};

export function isLowCtrInput(value: unknown): value is LowCtrInput {
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

export async function fetchLowCtrInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<LowCtrInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "query",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError("low_ctr_query: no GSC query facts");
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "query",
    previous.from,
    current.to,
  );
  // Stability gate: both windows must be covered at the grain level.
  for (const window of [current, previous]) {
    if (coverageRatio(rows, window) < minCoverage) {
      throw new InsufficientCoverageError(
        `low_ctr_query: query coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  const byQuery = new Map<string, LowCtrQueryRow>();
  for (const row of rows) {
    if (row.date < current.from || row.date > current.to) continue;
    const query = canonicalKeyword(row.query ?? row.grainKey);
    const existing = byQuery.get(query) ?? {
      query,
      impressions: 0,
      clicks: 0,
      position: 0,
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
  return {
    periodFrom: current.from,
    periodTo: current.to,
    rows: [...byQuery.values()].map((entry) => ({
      ...entry,
      position: entry.impressions > 0 ? entry.position / entry.impressions : 0,
    })),
    windowDays,
    thresholds: {
      minWindowDays: windowDays,
      minImpressions: thresholdNumber(ctx.thresholds, "minImpressions"),
      positionBandMin: thresholdNumber(ctx.thresholds, "positionBandMin"),
      positionBandMax: thresholdNumber(ctx.thresholds, "positionBandMax"),
      ctrFloor: thresholdNumber(ctx.thresholds, "ctrFloor"),
    },
  };
}

export function detectLowCtr(
  ctx: DetectorContext,
  input: LowCtrInput,
): FindingDraft[] {
  const minImpressions = thresholdNumber(ctx.thresholds, "minImpressions");
  const bandMin = thresholdNumber(ctx.thresholds, "positionBandMin");
  const bandMax = thresholdNumber(ctx.thresholds, "positionBandMax");
  const ctrFloor = thresholdNumber(ctx.thresholds, "ctrFloor");
  const findings: FindingDraft[] = [];
  for (const row of input.rows) {
    // Insufficient-data negative: below-floor impressions are ignored,
    // never emitted as low-confidence noise.
    if (row.impressions < minImpressions) continue;
    if (row.position < bandMin || row.position > bandMax) continue;
    const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
    if (ctr >= ctrFloor) continue;
    findings.push({
      entityKey: row.query,
      entity: { query: row.query },
      explanationFact:
        `Query "${row.query}" averages position ${row.position.toFixed(1)} ` +
        `with ${row.impressions.toLocaleString("en-US")} impressions but CTR ` +
        `${(ctr * 100).toFixed(2)}% (below ${(ctrFloor * 100).toFixed(2)}% floor) ` +
        `over ${input.periodFrom}..${input.periodTo}.`,
      evidence: {
        metrics: {
          impressions: row.impressions,
          clicks: row.clicks,
          ctr,
          position: row.position,
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
      confidenceScore: row.impressions >= minImpressions * 10 ? 70 : 60,
      coverageFlags: { queryCoverageDays: row.days },
    });
  }
  return findings;
}

export const lowCtrQueryDetector: DetectorDef = {
  detectorKey: "low_ctr_query",
  version: 1,
  requiredSources: ["gsc"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "gsc", grains: ["query", "query_page"], minCoverageRatio: 0.8 },
  ],
  detect: (ctx, input) => {
    if (!isLowCtrInput(input)) {
      throw new Error("low_ctr_query: mistyped input");
    }
    return detectLowCtr(ctx, input);
  },
};

export type { GscWindow };
