import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { splitWindows } from "./gscWindows";

/**
 * `ga4_organic_change` (final-plan §4/PR10): site-level GA4 session change,
 * current vs previous equivalent window. Single-source by design — GSC
 * raises composed insight confidence, never finding inputs. Unconnected
 * projects skip via the `ga4` version gate before the fetcher runs.
 */

export type Ga4ChangeWindow = {
  sessions: number;
  days: number;
  expectedDays: number;
};

export type Ga4ChangeInput = {
  periodFrom: string;
  periodTo: string;
  previousFrom: string;
  previousTo: string;
  current: Ga4ChangeWindow;
  previous: Ga4ChangeWindow;
  propertyId: string;
  thresholds: Record<string, string | number | boolean>;
};

function isWindow(value: unknown): value is Ga4ChangeWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessions" in value &&
    typeof value.sessions === "number" &&
    "days" in value &&
    typeof value.days === "number" &&
    "expectedDays" in value &&
    typeof value.expectedDays === "number"
  );
}

export function isGa4ChangeInput(value: unknown): value is Ga4ChangeInput {
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
    "propertyId" in value &&
    typeof value.propertyId === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export async function fetchGa4ChangeInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<Ga4ChangeInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const connection =
    await Ga4ConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new InsufficientCoverageError(
      "ga4_organic_change: no GA4 connection",
    );
  }
  // Anchor at the latest SUCCESS_*-covered summary date (deterministic —
  // never wall clock). Wide lookback, then clamp to the freshest date.
  const coverage = await Ga4SyncRepository.getGrainCoverage(
    projectId,
    connection.propertyId,
    "summary",
    "2000-01-01",
    "2100-01-01",
  );
  const latestDate = coverage.coveredDates[coverage.coveredDates.length - 1];
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "ga4_organic_change: no SUCCESS_* summary coverage",
    );
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  for (const window of [current, previous]) {
    const covered = coverage.coveredDates.filter(
      (date) => date >= window.from && date <= window.to,
    ).length;
    if (covered / windowDays < minCoverage) {
      throw new InsufficientCoverageError(
        `ga4_organic_change: summary SUCCESS_* coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  const series = await Ga4SyncRepository.getDailySummarySeries(
    projectId,
    connection.propertyId,
    previous.from,
    current.to,
  );
  const sum = (from: string, to: string): Ga4ChangeWindow => {
    let sessions = 0;
    const days = new Set<string>();
    for (const point of series) {
      if (point.date < from || point.date > to) continue;
      sessions += point.sessions;
      days.add(point.date);
    }
    return { sessions, days: days.size, expectedDays: windowDays };
  };
  return {
    periodFrom: current.from,
    periodTo: current.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    current: sum(current.from, current.to),
    previous: sum(previous.from, previous.to),
    propertyId: connection.propertyId,
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

export function detectGa4Change(
  ctx: DetectorContext,
  input: Ga4ChangeInput,
): FindingDraft[] {
  const ratio = thresholdNumber(ctx.thresholds, "declineRatio");
  const before = input.previous.sessions;
  const after = input.current.sessions;
  // No baseline, no ratio: zero rows are valid input, but a change finding
  // needs nonzero sessions to divide by.
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
      entity: { scope: "site", propertyId: input.propertyId },
      explanationFact: declined
        ? `GA4 sessions fell ${Math.abs(changeRatio * 100).toFixed(1)}% ` +
          `(${formatInt(before)} → ${formatInt(after)}) from ` +
          `${input.previousFrom}..${input.previousTo} to ` +
          `${input.periodFrom}..${input.periodTo}.`
        : `GA4 sessions grew ${(changeRatio * 100).toFixed(1)}% ` +
          `(${formatInt(before)} → ${formatInt(after)}) from ` +
          `${input.previousFrom}..${input.previousTo} to ` +
          `${input.periodFrom}..${input.periodTo}.`,
      evidence: {
        metrics: {
          sessionsBefore: before,
          sessionsAfter: after,
          changeRatio,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: ["ga4"],
        sourceRefs: {
          ga4Keys: [
            `ga4:${input.propertyId}:summary:${input.previousFrom}..${input.periodTo}`,
          ],
        },
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
        summaryCoverageCurrent:
          input.current.days / input.current.expectedDays,
        summaryCoveragePrevious:
          input.previous.days / input.previous.expectedDays,
      },
    },
  ];
}

export const ga4OrganicChangeDetector: DetectorDef = {
  detectorKey: "ga4_organic_change",
  version: 1,
  requiredSources: ["ga4"],
  // GSC agreement raises composed insight confidence (Task 11), never
  // finding inputs — intentionally no corroborators here.
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [{ source: "ga4", grains: ["summary"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isGa4ChangeInput(input)) {
      throw new Error("ga4_organic_change: mistyped input");
    }
    return detectGa4Change(ctx, input);
  },
};
