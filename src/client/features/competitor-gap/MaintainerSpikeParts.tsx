// Spec 014: Presentation parts for Maintainer Competitor-Gap Spike UI

import * as React from "react";
import { CheckCircle2, Play, RefreshCw } from "lucide-react";
import type {
  CompetitorGapSpikeEvidence,
  CompetitorGapVerdict,
} from "@/shared/competitorGap";
import type { FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST } from "./frozenSpikeManifest";

export type VerdictStatusDisplayData = {
  verdict: CompetitorGapVerdict | null;
  gateState: "NO_VERDICT" | "BLOCKED" | "READY";
  verdictId?: string;
  recordedAt?: string;
  evidence?: CompetitorGapSpikeEvidence;
  thresholds?: typeof FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds;
};

/** Helper to extract and format the required dimensions from evidence */
export function formatSpikeEvidence(evidence?: CompetitorGapSpikeEvidence) {
  if (!evidence) return null;

  const quality = evidence.quality;
  const coverage = evidence.coverage;
  const cost = evidence.cost;
  const identity = evidence.identity;
  const cache = evidence.cache;

  const unavailableDimensions: string[] = [];
  if (quality.status === "unavailable") {
    unavailableDimensions.push(`Quality (${quality.reason})`);
  }
  if (coverage.status === "unavailable") {
    unavailableDimensions.push(`Coverage (${coverage.reason})`);
  }
  if (cost.status === "unavailable") {
    unavailableDimensions.push(`Cost (${cost.reason})`);
  }
  if (identity.status === "unavailable") {
    unavailableDimensions.push(`Identity (${identity.reason})`);
  }
  if (cache.status === "unavailable") {
    unavailableDimensions.push(`Cache (${cache.reason})`);
  }

  return {
    keywordCoverageRatio:
      quality.status === "measured"
        ? `${(quality.value.keywordCoverageRatio * 100).toFixed(1)}%`
        : "unavailable",
    firstPartyCoverageRatio:
      coverage.status === "measured"
        ? `${(coverage.value.firstPartyCoverageRatio * 100).toFixed(1)}%`
        : "unavailable",
    costPerAnalysisCredits:
      cost.status === "measured"
        ? `${cost.value.measuredCreditsPerAnalysis} credits`
        : "unavailable",
    repeatCacheHitRate:
      cache.status === "measured"
        ? `${(cache.value.repeatCacheHitRate * 100).toFixed(1)}%`
        : "unavailable",
    repeatAnalysisPaidCalls:
      cache.status === "measured"
        ? String(cache.value.repeatAnalysisPaidCalls)
        : "unavailable",
    identityCollisions:
      identity.status === "measured"
        ? String(identity.value.collisionsObserved)
        : "unavailable",
    identityDeterministic:
      identity.status === "measured"
        ? identity.value.nonDeterministicMappings === 0
          ? "YES"
          : "NO"
        : "unavailable",
    unavailableDimensions:
      unavailableDimensions.length > 0
        ? unavailableDimensions.join(", ")
        : "None (all dimensions measured)",
  };
}

export function FrozenManifestSummary({
  manifest,
}: {
  manifest: typeof FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-base-200 bg-base-200/50 p-4 text-xs">
      <div className="flex items-center justify-between border-b border-base-300 pb-2">
        <span className="font-semibold uppercase tracking-wider text-base-content/70">
          Frozen Manifest Values (Immutable)
        </span>
        <span className="badge badge-outline badge-xs font-mono">
          spec 014 §9
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="text-base-content/50">Target Project:</span>
          <div
            data-testid="manifest-project-id"
            className="font-mono font-medium text-base-content"
          >
            {manifest.projectId}
          </div>
        </div>
        <div>
          <span className="text-base-content/50">Competitors Sample:</span>
          <div
            data-testid="manifest-sample-domains"
            className="font-mono font-medium text-base-content"
          >
            {manifest.sampleDomains.join(", ")}
          </div>
        </div>
        <div>
          <span className="text-base-content/50">Keyword Set Ref:</span>
          <div
            data-testid="manifest-keyword-set"
            className="font-mono font-medium text-base-content"
          >
            {manifest.keywordSetRef}
          </div>
        </div>
        <div>
          <span className="text-base-content/50">Market:</span>
          <div
            data-testid="manifest-market"
            className="font-mono font-medium text-base-content"
          >
            locationCode {manifest.market.locationCode} · lang &quot;
            {manifest.market.languageCode}&quot;
          </div>
        </div>
        <div>
          <span className="text-base-content/50">Budget Ceiling:</span>
          <div
            data-testid="manifest-budget"
            className="font-mono font-medium text-base-content"
          >
            {manifest.budgetCapCredits} credits (timebox:{" "}
            {manifest.timeBoxHours}h)
          </div>
        </div>
        <div>
          <span className="text-base-content/50">Pre-Registered Gates:</span>
          <div
            data-testid="manifest-thresholds"
            className="font-mono font-medium text-base-content"
          >
            kw ≥ 50% · gsc ≥ 50% · cost ≤ 100 · cache = 1.0 · coll = 0
          </div>
        </div>
      </div>
    </div>
  );
}

export function RecordedVerdictCard({
  verdictData,
}: {
  verdictData: VerdictStatusDisplayData;
}) {
  const existingVerdict = verdictData.verdict;
  const existingVerdictId = verdictData.verdictId;
  const evidenceDetails = formatSpikeEvidence(verdictData.evidence);

  return (
    <div
      data-testid="verdict-recorded-display"
      className="space-y-4 rounded-xl border border-success/30 bg-success/5 p-5"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-success" />
          <h4 className="font-bold text-base-content">
            Spike Verdict Recorded
          </h4>
        </div>
        <span
          data-testid="verdict-pill"
          className={`badge font-bold ${
            existingVerdict === "COMPETITOR_GAP_READY"
              ? "badge-success text-success-content"
              : "badge-error text-error-content"
          }`}
        >
          {existingVerdict}
        </span>
      </div>

      <p className="text-xs text-base-content/70">
        A durable ledger row exists for this manifest. In accordance with the
        exactly-once invariant, repeat execution is locked out.
      </p>

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-base-300 bg-base-100 p-4 text-xs sm:grid-cols-2">
        <div>
          <span className="text-base-content/50 uppercase font-semibold text-[10px]">
            LEDGER_ROW_ID
          </span>
          <div
            data-testid="verdict-row-id"
            className="font-mono text-sm font-bold text-base-content break-all"
          >
            {existingVerdictId ?? "cgv_recorded"}
          </div>
        </div>
        <div>
          <span className="text-base-content/50 uppercase font-semibold text-[10px]">
            VERDICT
          </span>
          <div
            data-testid="verdict-name"
            className="font-mono text-sm font-bold text-base-content"
          >
            {existingVerdict}
          </div>
        </div>

        {evidenceDetails && (
          <>
            <div>
              <span className="text-base-content/50">
                keywordCoverageRatio:
              </span>
              <div
                data-testid="metric-keyword-coverage"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.keywordCoverageRatio}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">
                firstPartyCoverageRatio:
              </span>
              <div
                data-testid="metric-first-party-coverage"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.firstPartyCoverageRatio}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">
                costPerAnalysisCredits:
              </span>
              <div
                data-testid="metric-cost-per-analysis"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.costPerAnalysisCredits}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">repeatCacheHitRate:</span>
              <div
                data-testid="metric-cache-hit-rate"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.repeatCacheHitRate}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">
                repeatAnalysisPaidCalls:
              </span>
              <div
                data-testid="metric-repeat-paid-calls"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.repeatAnalysisPaidCalls}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">identityCollisions:</span>
              <div
                data-testid="metric-identity-collisions"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.identityCollisions}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">
                identityDeterministic:
              </span>
              <div
                data-testid="metric-identity-deterministic"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.identityDeterministic}
              </div>
            </div>
            <div>
              <span className="text-base-content/50">
                unavailable dimensions:
              </span>
              <div
                data-testid="metric-unavailable-dimensions"
                className="font-mono font-medium text-base-content"
              >
                {evidenceDetails.unavailableDimensions}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ExecutionArea({
  confirmed,
  setConfirmed,
  isExecuting,
  isProjectAligned,
  existingVerdict,
  onRun,
}: {
  confirmed: boolean;
  setConfirmed: (val: boolean) => void;
  isExecuting: boolean;
  isProjectAligned: boolean;
  existingVerdict: CompetitorGapVerdict | null;
  onRun: () => void;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-base-300 bg-base-100 p-5">
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2.5 cursor-pointer text-xs">
          <input
            data-testid="confirm-execution-checkbox"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={isExecuting || !isProjectAligned}
            className="checkbox checkbox-warning checkbox-sm mt-0.5"
          />
          <span className="text-base-content/80 leading-relaxed">
            I explicitly confirm invocation of the frozen Competitor Gap Spike
            (budget cap: 500 credits, max projected spend: 6 credits). This
            action executes real provider calls and permanently writes a
            verdict ledger row.
          </span>
        </label>

        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-base-content/50">
            {isExecuting ? (
              <span
                data-testid="execution-running-indicator"
                className="flex items-center gap-1.5 text-warning font-medium"
              >
                <RefreshCw className="size-3.5 animate-spin" />
                Measuring dimensions &amp; evaluating verdict...
              </span>
            ) : (
              "Exactly-once execution safety active"
            )}
          </span>

          <button
            data-testid="run-competitor-gap-spike-btn"
            type="button"
            onClick={onRun}
            disabled={
              !confirmed ||
              isExecuting ||
              !isProjectAligned ||
              Boolean(existingVerdict)
            }
            className="btn btn-warning btn-sm gap-2"
          >
            {isExecuting ? (
              <>
                <span className="loading loading-spinner loading-xs" />
                Running Competitor Gap Spike...
              </>
            ) : (
              <>
                <Play className="size-3.5" />
                Run Competitor Gap Spike
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
