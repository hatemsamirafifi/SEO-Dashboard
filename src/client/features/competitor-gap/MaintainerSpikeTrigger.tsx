// Spec 014: Maintainer-Only Competitor-Gap Spike Invocation Surface
// Authenticated trigger placed in Settings / Debug / Developer Tools.
// Exactly-once safety, frozen manifest values, explicit confirmation,
// and ledger verdict polling and reporting.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, RefreshCw } from "lucide-react";
import {
  getCompetitorGapVerdict,
  runCompetitorGapSpike,
} from "@/serverFunctions/competitorGap";
import type { CompetitorGapVerdict } from "@/shared/competitorGap";
import type { CompetitorGapSpikeInput } from "@/types/schemas/competitorGap";
import {
  FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2,
  type FrozenCompetitorGapSpikeManifest,
} from "./frozenSpikeManifest";
import { isMaintainerSurfaceEnabled } from "./maintainerAccess";
import {
  ExecutionArea,
  FrozenManifestSummary,
  PreviousVerdictCard,
  RecordedVerdictCard,
  type VerdictStatusDisplayData,
} from "./MaintainerSpikeParts";

export {
  formatSpikeEvidence,
  type VerdictStatusDisplayData,
} from "./MaintainerSpikeParts";

export interface MaintainerSpikeTriggerProps {
  projectId: string;
  isMaintainer?: boolean;
}

export type SpikeExecutionOutcome =
  | {
      type: "ALREADY_RECORDED";
      verdict: CompetitorGapVerdict;
      verdictId?: string;
    }
  | {
      type: "INVOKED";
      rowId?: string;
      verdict?: CompetitorGapVerdict;
      pollResult?: VerdictStatusDisplayData;
    }
  | { type: "ERROR"; error: string }
  | { type: "ABORTED_IN_FLIGHT" };

export async function executeSpikeWithGuards({
  projectId,
  manifest,
  getVerdict,
  runSpike,
  inFlightLock,
}: {
  projectId: string;
  manifest: FrozenCompetitorGapSpikeManifest;
  getVerdict: (params: {
    data: { projectId: string; evaluationId?: string };
  }) => Promise<VerdictStatusDisplayData | null>;
  runSpike: (params: { data: CompetitorGapSpikeInput }) => Promise<{
    ok: boolean;
    verdict?: CompetitorGapVerdict;
    verdictId?: string;
    error?: string;
  }>;
  inFlightLock?: { current: boolean };
}): Promise<SpikeExecutionOutcome> {
  if (inFlightLock?.current) {
    return { type: "ABORTED_IN_FLIGHT" };
  }
  if (inFlightLock) {
    inFlightLock.current = true;
  }

  try {
    // Exactly-once safety: before invoking, check getCompetitorGapVerdict for this evaluation
    const existing = await getVerdict({
      data: { projectId, evaluationId: manifest.evaluationId },
    });
    if (existing?.verdict) {
      return {
        type: "ALREADY_RECORDED",
        verdict: existing.verdict,
        verdictId: existing.verdictId,
      };
    }

    // Invoke runCompetitorGapSpike exactly once
    const triggerRes = await runSpike({
      data: {
        ...manifest,
        sampleDomains: [...manifest.sampleDomains],
      },
    });
    if (!triggerRes?.ok) {
      return {
        type: "ERROR",
        error:
          triggerRes?.error ||
          "Spike execution refused: budget exceeded or provider error",
      };
    }

    // Poll getCompetitorGapVerdict after completion
    const pollResult = await getVerdict({
      data: { projectId, evaluationId: manifest.evaluationId },
    });
    return {
      type: "INVOKED",
      rowId: triggerRes.verdictId || pollResult?.verdictId,
      verdict: triggerRes.verdict || (pollResult?.verdict ?? undefined),
      pollResult: pollResult ?? undefined,
    };
  } catch (err: unknown) {
    return {
      type: "ERROR",
      error:
        err instanceof Error
          ? err.message
          : "Unexpected error during spike execution",
    };
  } finally {
    if (inFlightLock) {
      inFlightLock.current = false;
    }
  }
}

export function MaintainerSpikeTrigger({
  projectId,
  isMaintainer,
}: MaintainerSpikeTriggerProps) {
  // Gated: Maintainer surface only. Hidden completely for regular end users.
  const maintainerActive = isMaintainer ?? isMaintainerSurfaceEnabled();
  if (!maintainerActive) {
    return null;
  }

  const manifest = FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2;
  const isProjectAligned = projectId === manifest.projectId;

  const [confirmed, setConfirmed] = React.useState(false);
  const [isExecuting, setIsExecuting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const inFlightRef = React.useRef(false);

  // Poll / fetch verdict status for the specific evaluation
  const verdictQuery = useQuery({
    queryKey: ["competitorGapVerdict", projectId, manifest.evaluationId],
    queryFn: () =>
      getCompetitorGapVerdict({
        data: { projectId, evaluationId: manifest.evaluationId },
      }),
    refetchInterval: isExecuting ? 1500 : false,
  });

  const verdictData = (verdictQuery.data ??
    null) as VerdictStatusDisplayData | null;
  const existingVerdict = verdictData?.verdict ?? null;

  const handleRunSpike = async () => {
    if (inFlightRef.current || isExecuting || !confirmed) {
      return;
    }
    if (!isProjectAligned) {
      setServerError(
        `Wrong project context: Current project (${projectId}) does not match frozen manifest target (${manifest.projectId}).`,
      );
      return;
    }

    setIsExecuting(true);
    setServerError(null);

    try {
      const outcome = await executeSpikeWithGuards({
        projectId,
        manifest,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        getVerdict: (p) =>
          getCompetitorGapVerdict(
            p,
          ) as Promise<VerdictStatusDisplayData | null>,
        runSpike: (p) => runCompetitorGapSpike(p),
        inFlightLock: inFlightRef,
      });

      if (outcome.type === "ERROR") {
        setServerError(outcome.error);
      } else {
        await verdictQuery.refetch();
      }
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div
      data-testid="maintainer-spike-surface"
      className="space-y-6 rounded-xl border border-warning/30 bg-base-100 p-6 shadow-sm"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="badge badge-warning badge-sm font-semibold uppercase tracking-wider">
              Maintainer Only
            </span>
            <h3 className="text-lg font-bold text-base-content">
              Competitor Gap Spike (Spec 014, Part A)
            </h3>
          </div>
          <p className="mt-1 text-sm text-base-content/70">
            Authenticated execution surface for the frozen competitor-gap input
            measurement spike. Persists an auditable ledger row in{" "}
            <code className="text-xs">competitor_gap_verdicts</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => verdictQuery.refetch()}
            disabled={verdictQuery.isFetching || isExecuting}
            className="btn btn-ghost btn-xs gap-1"
            title="Refresh verdict state"
          >
            <RefreshCw
              className={`size-3.5 ${verdictQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Project Alignment Notice */}
      {!isProjectAligned && (
        <div className="alert alert-warning text-sm" role="alert">
          <AlertTriangle className="size-4 shrink-0" />
          <div>
            <div className="font-semibold">Project context mismatch</div>
            <div>
              The frozen manifest is pinned to project{" "}
              <code className="font-mono text-xs font-bold">
                {manifest.projectId}
              </code>{" "}
              (powersiment.ae). Active project is{" "}
              <code className="font-mono text-xs">{projectId}</code>. Invocation
              is disabled for this project.
            </div>
          </div>
        </div>
      )}

      {/* Historical Previous Evaluation (R1) */}
      {(verdictData?.previousVerdict ||
        manifest.evaluationId === "competitor-gap-g5-r2") && (
        <PreviousVerdictCard
          previousVerdict={
            verdictData?.previousVerdict ?? {
              verdict: "COMPETITOR_GAP_BLOCKED",
              verdictId: "cgv_4c878e65_2026-10-14T20:09:49.856Z",
              recordedAt: "2026-10-14T20:09:49.856Z",
            }
          }
        />
      )}

      {/* Frozen Manifest Display */}
      <FrozenManifestSummary manifest={manifest} />

      {/* Server Error Alert */}
      {serverError && (
        <div
          data-testid="server-error-banner"
          className="alert alert-error text-sm"
          role="alert"
        >
          <AlertCircle className="size-4 shrink-0" />
          <div>
            <span className="font-semibold">Invocation Error:</span>{" "}
            {serverError}
          </div>
        </div>
      )}

      {/* Execution Controls vs Recorded Verdict */}
      {existingVerdict && verdictData ? (
        <RecordedVerdictCard verdictData={verdictData} />
      ) : (
        <ExecutionArea
          confirmed={confirmed}
          setConfirmed={setConfirmed}
          isExecuting={isExecuting}
          isProjectAligned={isProjectAligned}
          existingVerdict={existingVerdict}
          onRun={handleRunSpike}
        />
      )}
    </div>
  );
}
