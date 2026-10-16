// Spec 014 (G5/P36) — competitor-gap input spike + verdict ledger contracts.
//
// Shared types for the Part A spike: a time-boxed measurement harness over
// the approved provider set that produces exactly one verdict
// (COMPETITOR_GAP_READY | COMPETITOR_GAP_BLOCKED) with frozen evidence.
//
// Invariants (Constitution):
// - P8/P9: a dimension that failed to measure is `unavailable` in evidence,
//   NEVER coerced to 0. Successful zero results are valid `0` values.
// - P42: the durable ledger row is authoritative; trace rows are
//   observability only.
// - P39: every read/write is (organizationId, projectId)-scoped.
// - Append-only: verdict rows are never updated or deleted; supersession is
//   a new row (FR-003).

/** Verdict enum — exactly one per spike run (FR-002). */
export const COMPETITOR_GAP_VERDICTS = [
  "COMPETITOR_GAP_READY",
  "COMPETITOR_GAP_BLOCKED",
] as const;
export type CompetitorGapVerdict = (typeof COMPETITOR_GAP_VERDICTS)[number];

export function isCompetitorGapVerdict(
  value: unknown,
): value is CompetitorGapVerdict {
  return (
    typeof value === "string" &&
    (COMPETITOR_GAP_VERDICTS as readonly unknown[]).includes(value)
  );
}

/**
 * Pre-registered thresholds (research R4). Declared in the spike input
 * manifest BEFORE execution; never edited after execution begins.
 */
export type CompetitorGapSpikeThresholds = {
  /** Minimum ratio of sampled keywords with ranked-keyword rows per domain. */
  minKeywordCoverageRatio: number;
  /** Minimum ratio of first-party (GSC/rank) coverage for the same window. */
  minFirstPartyCoverageRatio: number;
  /** Maximum measured credits for one full competitor-set analysis. */
  maxCostPerAnalysisCredits: number;
  /** Required repeat-analysis cache hit rate — must equal 1.0 to pass. */
  repeatCacheHitRate: number;
  /** Allowed canonical-identity collisions — must equal 0 to pass. */
  identityCollisionsAllowed: number;
};

/**
 * One measurement dimension. `unavailable` means the measurement FAILED
 * (provider failure, harness error) — a hard BLOCKED input, never a zero.
 * `measured` means the dimension completed and carries its value.
 */
export type SpikeDimensionResult<T> =
  | { status: "measured"; value: T }
  | { status: "unavailable"; reason: string };

export type CompetitorGapSpikeEvidence = {
  quality: SpikeDimensionResult<{
    keywordCoverageRatio: number;
    requiredFieldMissingRate: number;
  }>;
  coverage: SpikeDimensionResult<{
    firstPartyCoverageRatio: number;
    window: { from: string; to: string };
  }>;
  cost: SpikeDimensionResult<{
    measuredCreditsPerAnalysis: number;
    extrapolatedMonthlyPerProject: number;
  }>;
  identity: SpikeDimensionResult<{
    collisionsObserved: number;
    nonDeterministicMappings: number;
  }>;
  cache: SpikeDimensionResult<{
    repeatAnalysisPaidCalls: number;
    repeatCacheHitRate: number;
  }>;
};

/** Spike input manifest — declared before execution, frozen with the verdict. */
export type CompetitorGapSpikeManifest = {
  organizationId: string;
  projectId: string;
  evaluationId?: string;
  sampleDomains: string[];
  keywordSetRef: string;
  market: { locationCode: number; languageCode: string };
  budgetCapCredits: number;
  timeBoxHours: number;
  thresholds: CompetitorGapSpikeThresholds;
};

/** Ledger row as persisted (JSON columns parsed). */
export type CompetitorGapVerdictRow = {
  id: string;
  organizationId: string;
  projectId: string;
  verdict: CompetitorGapVerdict;
  evidence: CompetitorGapSpikeEvidence;
  thresholds: CompetitorGapSpikeThresholds;
  inputManifest: CompetitorGapSpikeManifest;
  recordedAt: string;
};

/**
 * Runtime gate state derived from the latest verdict row (contracts/
 * spike-and-verdict.md). `NO_VERDICT` and `BLOCKED` both hold Part B/C.
 */
export const COMPETITOR_GAP_GATE_STATES = [
  "NO_VERDICT",
  "BLOCKED",
  "READY",
] as const;
export type CompetitorGapGateState =
  (typeof COMPETITOR_GAP_GATE_STATES)[number];