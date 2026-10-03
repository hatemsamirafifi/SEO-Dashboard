import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4GoalRepository } from "@/server/features/ga4/repositories/Ga4GoalRepository";
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
 * `conversion_drop` (spec 010, C2b — research R5): per active goal,
 * site-level. Stored event grains carry no page dimension, so page×goal
 * findings would require fabricated joins; one finding per goal whose
 * windowed conversions fall beyond the threshold. Single-source by design
 * (ga4_organic_change precedent) — GSC raises composed insight confidence,
 * never finding inputs.
 */

export type ConversionGoalWindow = {
  goalId: string;
  /** Frozen name snapshot at fetch time — renames/archives never rewrite it. */
  goalName: string;
  eventName: string;
  propertyId: string;
  current: { conversions: number; days: number };
  previous: { conversions: number; days: number };
};

export type ConversionDropInput = {
  periodFrom: string;
  periodTo: string;
  previousFrom: string;
  previousTo: string;
  windowDays: number;
  goals: ConversionGoalWindow[];
  thresholds: Record<string, string | number | boolean>;
};

function isGoalWindow(value: unknown): value is ConversionGoalWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "goalId" in value &&
    typeof value.goalId === "string" &&
    "goalName" in value &&
    typeof value.goalName === "string" &&
    "current" in value &&
    typeof value.current === "object" &&
    value.current !== null &&
    "previous" in value &&
    typeof value.previous === "object" &&
    value.previous !== null
  );
}

export function isConversionDropInput(
  value: unknown,
): value is ConversionDropInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "goals" in value &&
    Array.isArray(value.goals) &&
    value.goals.every(isGoalWindow) &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export async function fetchConversionDropInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<ConversionDropInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    ctx.organizationId,
  );
  if (!connection) {
    throw new InsufficientCoverageError("conversion_drop: no GA4 connection");
  }
  const goals = (
    await Ga4GoalRepository.listByProject(projectId, ctx.organizationId, false)
  ).filter((goal) => !goal.archivedAt);
  if (goals.length === 0) {
    throw new InsufficientCoverageError("conversion_drop: no active goals");
  }
  // Anchor at the latest SUCCESS_*-covered events date (deterministic —
  // never wall clock; ga4OrganicChange precedent).
  const coverage = await Ga4SyncRepository.getGrainCoverage(
    projectId,
    connection.propertyId,
    "events",
    "2000-01-01",
    "2100-01-01",
  );
  const latestDate = coverage.coveredDates[coverage.coveredDates.length - 1];
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "conversion_drop: no SUCCESS_* events coverage",
    );
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  const coveredIn = (from: string, to: string): number =>
    coverage.coveredDates.filter((date) => date >= from && date <= to).length;
  for (const window of [current, previous]) {
    if (coveredIn(window.from, window.to) / windowDays < minCoverage) {
      throw new InsufficientCoverageError(
        `conversion_drop: events SUCCESS_* coverage below ${minCoverage} ` +
          `for ${window.from}..${window.to}`,
      );
    }
  }
  const goalWindows: ConversionGoalWindow[] = [];
  for (const goal of goals) {
    const [currentRead, previousRead] = await Promise.all([
      Ga4SyncRepository.getGoalConversions({
        projectId,
        propertyId: connection.propertyId,
        eventName: goal.eventName,
        matchKeyEventOnly: goal.matchKeyEventOnly,
        from: current.from,
        to: current.to,
      }),
      Ga4SyncRepository.getGoalConversions({
        projectId,
        propertyId: connection.propertyId,
        eventName: goal.eventName,
        matchKeyEventOnly: goal.matchKeyEventOnly,
        from: previous.from,
        to: previous.to,
      }),
    ]);
    goalWindows.push({
      goalId: goal.id,
      goalName: goal.name,
      eventName: goal.eventName,
      propertyId: connection.propertyId,
      current: {
        conversions: currentRead.conversions,
        days: currentRead.coveredDates.length,
      },
      previous: {
        conversions: previousRead.conversions,
        days: previousRead.coveredDates.length,
      },
    });
  }
  return {
    periodFrom: current.from,
    periodTo: current.to,
    previousFrom: previous.from,
    previousTo: previous.to,
    windowDays,
    goals: goalWindows,
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      minEventsPerWindow: thresholdNumber(ctx.thresholds, "minEventsPerWindow"),
      declineRatio: thresholdNumber(ctx.thresholds, "declineRatio"),
    },
  };
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function detectConversionDrop(
  ctx: DetectorContext,
  input: ConversionDropInput,
): FindingDraft[] {
  const ratio = thresholdNumber(ctx.thresholds, "declineRatio");
  const floor = thresholdNumber(ctx.thresholds, "minEventsPerWindow");
  const findings: FindingDraft[] = [];
  for (const goal of input.goals) {
    const before = goal.previous.conversions;
    const after = goal.current.conversions;
    // No baseline, no ratio. The absolute floor sits on the BASELINE window:
    // 12→3 emits, 2→0 never does (contract example governs).
    if (before < floor) continue;
    const changeRatio = (after - before) / before;
    // Drops only: growth is not a conversion-drop opportunity.
    if (changeRatio > -ratio) continue;
    const fullCoverage =
      goal.current.days >= input.windowDays &&
      goal.previous.days >= input.windowDays;
    findings.push({
      entityKey: `goal:${goal.goalId}`,
      entity: {
        scope: "goal",
        goalId: goal.goalId,
        goalName: goal.goalName,
        eventName: goal.eventName,
        propertyId: goal.propertyId,
      },
      explanationFact:
        `Conversions for goal "${goal.goalName}" fell ` +
        `${Math.abs(changeRatio * 100).toFixed(1)}% ` +
        `(${formatInt(before)} → ${formatInt(after)}) from ` +
        `${input.previousFrom}..${input.previousTo} to ` +
        `${input.periodFrom}..${input.periodTo}.`,
      evidence: {
        metrics: {
          goalName: goal.goalName,
          goalId: goal.goalId,
          eventName: goal.eventName,
          conversionsBefore: before,
          conversionsAfter: after,
          changeRatio,
          windowDays: input.windowDays,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: ["ga4"],
        sourceRefs: {
          ga4Keys: [
            `ga4:${goal.propertyId}:events:${goal.eventName}:${input.previousFrom}..${input.periodTo}`,
          ],
        },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: {
          coverageCurrent: goal.current.days / input.windowDays,
          coveragePrevious: goal.previous.days / input.windowDays,
          goalBaseline: before,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: fullCoverage ? 70 : 60,
      coverageFlags: {
        eventsCoverageCurrent: goal.current.days / input.windowDays,
        eventsCoveragePrevious: goal.previous.days / input.windowDays,
      },
    });
  }
  return findings;
}

export const conversionDropDetector: DetectorDef = {
  detectorKey: "conversion_drop",
  version: 1,
  requiredSources: ["ga4"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [{ source: "ga4", grains: ["events"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isConversionDropInput(input)) {
      throw new Error("conversion_drop: mistyped input");
    }
    return detectConversionDrop(ctx, input);
  },
};
