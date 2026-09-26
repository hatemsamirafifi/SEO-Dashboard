import { createServerFn } from "@tanstack/react-start";
import {
  FindingService,
  type ManualScanOutcome,
} from "@/server/features/intelligence/services/FindingService";
import {
  ScanLedgerRepository,
  type IntelligenceRunRow,
} from "@/server/features/intelligence/repositories/ScanLedgerRepository";
import {
  intelligenceScanStatusSchema,
  triggerIntelligenceScanSchema,
} from "@/types/schemas/intelligence";
import { requireProjectContext } from "./middleware";

/** Pure response shaping for the manual trigger (unit-tested directly). */
export function toTriggerScanResponse(outcome: ManualScanOutcome) {
  if (!outcome.ok) {
    if ("rateLimited" in outcome) {
      return {
        ok: false as const,
        rateLimited: true as const,
        retryAfterMs: outcome.retryAfterMs,
      };
    }
    if (outcome.deferred) {
      return {
        ok: false as const,
        deferred: "active_mutation" as const,
        active: outcome.active,
      };
    }
    return {
      ok: false as const,
      runId: outcome.run.id,
      error: outcome.run.error,
      errorClass: outcome.run.errorClass,
    };
  }
  return {
    ok: true as const,
    runId: outcome.run.id,
    status: outcome.run.status,
    stage: outcome.run.currentStage,
    findingsCount: outcome.findingsCount,
  };
}

/** Pure response shaping for the status poll (unit-tested directly). */
export function toScanStatusResponse(run: IntelligenceRunRow | null) {
  if (!run) {
    return { run: null };
  }
  return {
    run: {
      id: run.id,
      status: run.status,
      stage: run.currentStage,
      triggeredBy: run.triggeredBy,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      findingsCount: run.findingsCount,
      error: run.error,
      errorClass: run.errorClass,
    },
  };
}

/**
 * Manual scan trigger. Bypasses the `changed` predicate but honors the
 * 1-per-15-min-per-project rate limit (final-plan §8). Returns the Stage-1
 * outcome; the run is parked at `materializing` until Tasks 8/11 ship.
 */
export const triggerIntelligenceScan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(triggerIntelligenceScanSchema)
  .handler(async ({ context }) => {
    const outcome = await FindingService.triggerManualScan({
      projectId: context.projectId,
      organizationId: context.organizationId,
      actorUserId: context.userId,
    });
    return toTriggerScanResponse(outcome);
  });

/** Latest run status for polling UIs. */
export const getIntelligenceScanStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(intelligenceScanStatusSchema)
  .handler(async ({ context }) => {
    const latest = await ScanLedgerRepository.getLatestRun(context.projectId);
    return toScanStatusResponse(latest);
  });
