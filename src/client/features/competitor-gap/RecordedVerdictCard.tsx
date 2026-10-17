// Spec 014: Recorded verdict card for Maintainer Competitor-Gap Spike UI
import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import {
  formatSpikeEvidence,
  type VerdictStatusDisplayData,
} from "./MaintainerSpikeEvidence";

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
