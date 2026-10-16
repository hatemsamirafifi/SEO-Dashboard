// Spec 014: Presentation parts for Maintainer Competitor-Gap Spike UI

import * as React from "react";
import { Play, RefreshCw } from "lucide-react";
import type { CompetitorGapVerdict } from "@/shared/competitorGap";
import type { FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST } from "./frozenSpikeManifest";

export {
  formatSpikeEvidence,
  type VerdictStatusDisplayData,
} from "./MaintainerSpikeEvidence";

export function PreviousVerdictCard({
  previousVerdict,
}: {
  previousVerdict: {
    verdict: CompetitorGapVerdict;
    verdictId: string;
    recordedAt: string;
  };
}) {
  return (
    <div
      data-testid="previous-verdict-card"
      className="space-y-3 rounded-xl border border-error/30 bg-error/5 p-4 text-xs"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase tracking-wider text-base-content/70">
            Previous evaluation:
          </span>
          <span
            data-testid="previous-verdict-pill"
            className="badge badge-error badge-sm font-bold"
          >
            {previousVerdict.verdict}
          </span>
        </div>
        <span className="text-[11px] font-mono text-base-content/50">
          R1 Historical
        </span>
      </div>
      <div className="flex items-center gap-2 font-mono">
        <span className="text-base-content/50">Row ID:</span>
        <span
          data-testid="previous-verdict-id"
          className="font-bold text-base-content break-all"
        >
          {previousVerdict.verdictId}
        </span>
      </div>
      <p className="text-[11px] text-base-content/60">
        Historical R1 evidence preserved immutably. Authoritative ledger entry
        is not superseded or deleted.
      </p>
    </div>
  );
}

export function FrozenManifestSummary({
  manifest,
}: {
  manifest: typeof FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-base-200 bg-base-200/50 p-4 text-xs">
      <div className="flex items-center justify-between border-b border-base-300 pb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase tracking-wider text-base-content/70">
            Evaluation:
          </span>
          <span
            data-testid="evaluation-title"
            className="font-bold text-base-content text-sm"
          >
            Competitor Gap G5 R2
          </span>
          <span className="badge badge-warning badge-xs font-mono">
            {manifest.evaluationId ?? "competitor-gap-g5-r2"}
          </span>
        </div>
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

export { RecordedVerdictCard } from "./RecordedVerdictCard";

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
      <div className="flex items-center justify-between border-b border-base-200 pb-2">
        <span
          data-testid="current-evaluation-status"
          className="font-semibold text-xs text-base-content/70"
        >
          Current evaluation: R2 — not yet executed
        </span>
        <span className="badge badge-sm badge-warning badge-outline font-mono">
          R2 Pending
        </span>
      </div>
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
            action executes real provider calls and permanently writes a verdict
            ledger row.
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
