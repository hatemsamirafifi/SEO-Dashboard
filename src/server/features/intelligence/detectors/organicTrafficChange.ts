import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import {
  coverageRatio,
  splitWindows,
  sumWindow,
  type GscWindow,
} from "./gscWindows";

/**
 * `organic_traffic_change` (final-plan §4): site-level GSC summary clicks,
 * current vs previous equivalent window. Single-source by design — the other
 * source raises composed insight confidence, never finding confidence.
 */

export type TrafficChangeWindow = {
  clicks: number;
  impressions: number;
  days: number;
  expectedDays: number;
};

export type TrafficChangeInput = {
  periodFrom: string;
  periodTo: string;
  previousFrom: string;
  previousTo: string;
  current: TrafficChangeWindow;
  previous: TrafficChangeWindow;
  factIds: string[];
  thresholds: Record<string, string | number | boolean>;
};

function isWindow(value: unknown): value is TrafficChangeWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "clicks" in value &&
    typeof value.clicks === "number" &&
    "impressions" in value &&
    typeof value.impressions === "number" &&
    "days" in value &&
    typeof value.days === "number" &&
    "expectedDays" in value &&
    typeof value.expectedDays === "number"
  );
}

export function isTrafficChangeInput(
  value: unknown,
): value is TrafficChangeInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "current" in value &&
    isWindow(value.current) &&
    "previous" in value &&
    isWindow(value.previous) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "previousFrom" in value &&
    typeof value.previousFrom === "string" &&
    "previousTo" in value &&
    typeof value.previousTo === "string" &&
    "factIds" in value &&
    Array.isArray(value.factIds) &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export async function fetchTrafficChangeInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<TrafficChangeInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "summary",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "organic_traffic_change: no GSC summary facts",
    );
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "summary",
    previous.from,
    current.to,
  );
  for (const window of [current, previous]) {
    if (coverageRatio(rows, window) < minCoverage) {
      throw new InsufficientCoverageError(
        `organic_traffic_change: summary coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  const currentSum = sumWindow(rows, current);
  const previousSum = sumWindow(rows, previous);
  return {
    periodFrom: current.from,
    periodTo: current.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    current: { ...currentSum, expectedDays: windowDays },
    previous: { ...previousSum, expectedDays: windowDays },
    factIds: rows.map((row) => row.id),
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      declineRatio: thresholdNumber(ctx.thresholds, "declineRatio"),
    },
  };
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function detectOrganicTrafficChange(
  ctx: DetectorContext,
  input: TrafficChangeInput,
): FindingDraft[] {
  const ratio = thresholdNumber(ctx.thresholds, "declineRatio");
  const before = input.previous.clicks;
  const after = input.current.clicks;
  // No baseline, no ratio: zero rows are valid input, but a change finding
  // needs a nonzero baseline to divide by.
  if (before <= 0) return [];
  const changeRatio = (after - before) / before;
  if (Math.abs(changeRatio) < ratio) return [];
  const declined = changeRatio < 0;
  const fullCoverage =
    input.current.days >= input.current.expectedDays &&
    input.previous.days >= input.previous.expectedDays;
  return [
    {
      entityKey: "site",
      entity: { scope: "site" },
      explanationFact: declined
        ? `Organic clicks fell ${Math.abs(changeRatio * 100).toFixed(1)}% ` +
          `(${formatInt(before)} → ${formatInt(after)}) from ` +
          `${input.previousFrom}..${input.previousTo} to ` +
          `${input.periodFrom}..${input.periodTo}.`
        : `Organic clicks grew ${(changeRatio * 100).toFixed(1)}% ` +
          `(${formatInt(before)} → ${formatInt(after)}) from ` +
          `${input.previousFrom}..${input.previousTo} to ` +
          `${input.periodFrom}..${input.periodTo}.`,
      evidence: {
        metrics: {
          clicksBefore: before,
          clicksAfter: after,
          changeRatio,
          impressionsBefore: input.previous.impressions,
          impressionsAfter: input.current.impressions,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: ["gsc"],
        sourceRefs: { gscFactIds: input.factIds.slice(0, 200) },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: {
          coverageCurrent: input.current.days / input.current.expectedDays,
          coveragePrevious: input.previous.days / input.previous.expectedDays,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: fullCoverage ? 70 : 60,
      coverageFlags: {
        summaryCoverageCurrent: input.current.days / input.current.expectedDays,
        summaryCoveragePrevious:
          input.previous.days / input.previous.expectedDays,
      },
    },
  ];
}

export const organicTrafficChangeDetector: DetectorDef = {
  detectorKey: "organic_traffic_change",
  version: 1,
  requiredSources: ["gsc"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [{ source: "gsc", grains: ["summary"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isTrafficChangeInput(input)) {
      throw new Error("organic_traffic_change: mistyped input");
    }
    return detectOrganicTrafficChange(ctx, input);
  },
};

// Re-export the window type for evidence builders (keeps imports shallow).
export type { GscWindow };
