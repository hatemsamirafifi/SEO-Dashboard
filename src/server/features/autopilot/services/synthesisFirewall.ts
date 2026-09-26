import { AppError } from "@/server/lib/errors";
import { hashSourceState } from "@/server/features/intelligence/services/SourceTokens";
import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { isStepKind } from "./stepSupport";
import type { AttemptPin, PriorStepEvidence } from "./autopilotTypes";

export function isAttemptPin(value: unknown): value is AttemptPin {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("versions" in value) ||
    !("sourceSet" in value) ||
    !("detectorVersions" in value) ||
    !("thresholdVersion" in value)
  ) {
    return false;
  }
  return (
    typeof value.versions === "object" &&
    value.versions !== null &&
    Array.isArray(value.sourceSet) &&
    typeof value.detectorVersions === "object" &&
    value.detectorVersions !== null &&
    typeof value.thresholdVersion === "number"
  );
}

export function parseStoredPin(attempt: {
  sourceVersionsJson: string;
}): AttemptPin {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(attempt.sourceVersionsJson) as unknown;
  } catch {
    throw new AppError(
      "INTERNAL_ERROR",
      "Attempt carries unparseable versions",
    );
  }
  if (!isAttemptPin(parsed)) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Attempt carries unparseable versions",
    );
  }
  return parsed;
}

/**
 * Synthesis firewall (final-plan §13): synthesis may only consume frozen
 * step evidence from ONE attempt whose versions hash equals the attempt pin.
 * Cross-attempt or unversioned sets throw — mixed-version synthesis is
 * structurally impossible through this predicate.
 */
export async function assertSynthesisInput(input: {
  attemptId: string;
  seqs: number[];
}): Promise<PriorStepEvidence[]> {
  const attempt = await AutopilotRepository.getAttempt(input.attemptId);
  if (!attempt) throw new AppError("NOT_FOUND", "Autopilot attempt not found");
  const out: PriorStepEvidence[] = [];
  for (const seq of input.seqs) {
    const step = await AutopilotRepository.getStep(input.attemptId, seq);
    if (!step || step.status !== "completed" || !step.evidenceJson) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Step ${seq} is not completed frozen evidence`,
      );
    }
    let versions: unknown = null;
    try {
      versions = JSON.parse(
        step.effectiveSourceVersionsJson ?? "null",
      ) as unknown;
    } catch {
      throw new AppError(
        "VALIDATION_ERROR",
        `Step ${seq} carries unparseable versions`,
      );
    }
    if (!isAttemptPin(versions)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Step ${seq} carries unparseable versions`,
      );
    }
    const stepHash = await hashSourceState(versions);
    if (stepHash !== attempt.sourceVersionsHash) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Step ${seq} belongs to a different evidence universe`,
      );
    }
    let evidence: unknown = null;
    try {
      evidence = JSON.parse(step.evidenceJson) as unknown;
    } catch {
      throw new AppError(
        "VALIDATION_ERROR",
        `Step ${seq} carries unparseable evidence`,
      );
    }
    if (!isStepKind(step.kind)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Step ${seq} carries an unknown kind`,
      );
    }
    out.push({
      seq,
      kind: step.kind,
      name: step.name,
      evidence,
      evidenceHash: step.evidenceHash ?? "",
    });
  }
  return out;
}
