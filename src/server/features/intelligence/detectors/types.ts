import type { z } from "zod";
import type { findingSchema, opportunitySchema } from "@/shared/intelligence";
import type { DetectorThresholds } from "@/shared/intelligence-thresholds";

export type Finding = z.infer<typeof findingSchema>;
export type Opportunity = z.infer<typeof opportunitySchema>;

/** Sources a detector may require or corroborate with. */
export type DetectionSource = "gsc" | "ga4" | "rank" | "audit" | "backlinks";

/**
 * Coverage requirement for one source: the grain(s) that must hold
 * SUCCESS_* coverage, and the minimum covered ratio of the window.
 */
export type CoverageRequirement = {
  source: DetectionSource;
  grains: string[];
  minCoverageRatio: number;
};

/** Pre-fetched inputs handed to a detector (never live repository reads). */
export type DetectorContext = {
  projectId: string;
  organizationId: string;
  periodFrom: string;
  periodTo: string;
  thresholds: DetectorThresholds;
  thresholdVersion: number;
};

/**
 * Draft emitted by a detector before identity stamping. Detectors emit
 * `explanationFact` only — recommendations are added exclusively by the
 * materializer (per-detectorKey templates) and composer.
 */
export type FindingDraft = {
  entityKey: string;
  entity: Record<string, string | number | boolean | undefined>;
  /** Fact-only prose (no recommendation, no causal verbs — observational). */
  explanationFact: string;
  evidence: {
    metrics: Record<string, string | number | boolean>;
    periods?: { from: string; to: string };
    sources: DetectionSource[];
    sourceRefs?: {
      gscFactIds?: string[];
      rankSnapshotIds?: Array<string | number>;
      auditIssueIds?: string[];
      ga4Keys?: string[];
    };
    thresholdsApplied: Record<string, string | number | boolean>;
    correlations: Array<{
      entityRef: string;
      sharedWindow?: { from: string; to: string };
      note: string;
    }>;
    evidenceType: "observational";
    partialData: string[];
    confidenceInputs: Record<string, string | number | boolean>;
  };
  detectedAt: string;
  confidenceScore: number;
  coverageFlags: Record<string, string | number | boolean>;
};

/**
 * Reads an injected numeric threshold. Thresholds are injected, never
 * hardcoded: a missing or mistyped threshold is a loud config error (failed
 * detector), never a silent default.
 */
export function thresholdNumber(
  thresholds: DetectorThresholds,
  key: string,
): number {
  const value: unknown = thresholds[key];
  if (typeof value !== "number") {
    throw new Error(`Detector threshold missing or not numeric: ${key}`);
  }
  return value;
}

/**
 * Thrown by input fetchers when required source coverage is insufficient
 * (FAILED/missing grain coverage, too few snapshots, no completed audit).
 * The detection stage records the detector as `skipped` with the reason —
 * distinct from detector bugs, which record `failed`.
 */
export class InsufficientCoverageError extends Error {
  constructor(reason: string) {
    super(`INSUFFICIENT_COVERAGE: ${reason}`);
    this.name = "InsufficientCoverageError";
  }
}

/**
 * Detector definition: stable key (part of finding/opportunity identity),
 * integer version (major bumps supersede, minor bumps update in place),
 * required sources + optional corroborators, minimum confidence to emit,
 * and a pure synchronous detect over pre-fetched inputs.
 */
export type DetectorDef = {
  detectorKey: string;
  version: number;
  requiredSources: DetectionSource[];
  optionalCorroborators: DetectionSource[];
  minConfidenceToEmit: number;
  coverage: CoverageRequirement[];
  detect: (ctx: DetectorContext, input: unknown) => FindingDraft[];
};
