import { THRESHOLD_VERSION } from "@/shared/intelligence-thresholds";
import { buildFindingKey, type Finding } from "@/shared/intelligence";
import { defaultThresholdsFor } from "@/shared/intelligence-thresholds";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import { listDetectors } from "../detectors/registry";
import {
  InsufficientCoverageError,
  type DetectorContext,
  type DetectorDef,
} from "../detectors/types";
import type { DetectionSourceState } from "./SourceTokens";

/** Fetches one detector's pre-fetched input. Detector-specific fetchers
 *  land with the detectors (Task 7); Stage 1 never reads source tables
 *  itself. */
export type DetectorInputFetcher = (
  detectorKey: string,
  ctx: DetectorContext,
) => Promise<unknown>;

/**
 * Runs every registered detector with version-level source gating. A
 * detector whose required source has no committed version (null =
 * unconnected/no valid mutation) is SKIPPED with reason — never fed empty
 * input as if it were data. Finer FAILED-grain gating is detector-specific
 * and arrives with the detectors (Task 7).
 */
export async function runDetectionStage(input: {
  projectId: string;
  organizationId: string;
  runId: string;
  state: DetectionSourceState;
  detectors?: DetectorDef[];
  fetchInput?: DetectorInputFetcher;
}): Promise<Finding[]> {
  const detectors = input.detectors ?? listDetectors();
  const findings: Finding[] = [];
  const detectedAt = new Date().toISOString();

  for (const detector of detectors) {
    const missing = detector.requiredSources.filter(
      (source) => input.state.versions[source] === null,
    );
    if (missing.length > 0) {
      await ScanLedgerRepository.recordDetectorOutcome({
        runId: input.runId,
        detectorKey: detector.detectorKey,
        status: "skipped",
        skipReason: `required source has no committed version: ${missing.join(",")}`,
      });
      continue;
    }
    const ctx: DetectorContext = {
      projectId: input.projectId,
      organizationId: input.organizationId,
      periodFrom: "",
      periodTo: "",
      thresholds: defaultThresholdsFor(detector.detectorKey),
      thresholdVersion: THRESHOLD_VERSION,
    };
    try {
      const detectorInput = input.fetchInput
        ? await input.fetchInput(detector.detectorKey, ctx)
        : null;
      if (detectorInput === null) {
        await ScanLedgerRepository.recordDetectorOutcome({
          runId: input.runId,
          detectorKey: detector.detectorKey,
          status: "skipped",
          skipReason: "no input fetcher registered for detector",
        });
        continue;
      }
      const drafts = detector.detect(ctx, detectorInput);
      const emittedBefore = findings.length;
      for (const draft of drafts) {
        // Framework-level floor: below-min-confidence drafts never emit.
        if (draft.confidenceScore < detector.minConfidenceToEmit) {
          continue;
        }
        findings.push({
          findingKey: await buildFindingKey({
            projectId: input.projectId,
            detectorKey: detector.detectorKey,
            detectorVersion: detector.version,
            entityKey: draft.entityKey,
            periodFrom: draft.evidence.periods?.from ?? "",
            periodTo: draft.evidence.periods?.to ?? "",
          }),
          detectorKey: detector.detectorKey,
          detectorVersion: detector.version,
          projectId: input.projectId,
          entityKey: draft.entityKey,
          entity: draft.entity,
          explanationFact: draft.explanationFact,
          evidence: draft.evidence,
          detectedAt: draft.detectedAt || detectedAt,
          confidenceScore: draft.confidenceScore,
          coverageFlags: draft.coverageFlags,
        });
      }
      await ScanLedgerRepository.recordDetectorOutcome({
        runId: input.runId,
        detectorKey: detector.detectorKey,
        status: "completed",
        findingsCount: findings.length - emittedBefore,
      });
    } catch (error) {
      if (error instanceof InsufficientCoverageError) {
        await ScanLedgerRepository.recordDetectorOutcome({
          runId: input.runId,
          detectorKey: detector.detectorKey,
          status: "skipped",
          skipReason: error.message,
        });
        continue;
      }
      await ScanLedgerRepository.recordDetectorOutcome({
        runId: input.runId,
        detectorKey: detector.detectorKey,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return findings;
}
