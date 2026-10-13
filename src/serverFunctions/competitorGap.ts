// Spec 014 (G5/P36) — thin server functions for the competitor-gap input
// spike (Part A, the only unconditional part of this package).
//
// Layering (P1): authentication + project context + strict input validation
// happen here; measurement, verdict evaluation, and persistence live in
// src/server/lib/competitor-gap/. The verdict ledger row is the durable
// gate consumed by future Part B/C code paths.

import { createServerFn } from "@tanstack/react-start";
import { competitorGapGateState } from "@/server/lib/competitor-gap/verdictLedger";
import {
  runSpike,
  SpikeBudgetExceededError,
} from "@/server/lib/competitor-gap/spikeHarness";
import {
  competitorGapSpikeInputSchema,
  competitorGapVerdictStatusSchema,
} from "@/types/schemas/competitorGap";
import type { CompetitorGapVerdictRow } from "@/shared/competitorGap";
import { requireProjectContext } from "./middleware";

/** Pure response shaping for the spike trigger (unit-tested directly). */
export function toSpikeTriggerResponse(
  outcome:
    | { ok: true; row: CompetitorGapVerdictRow }
    | { ok: false; budgetExceeded: true; message: string },
) {
  if (!outcome.ok) {
    return {
      ok: false as const,
      budgetExceeded: true as const,
      error: outcome.message,
    };
  }
  return {
    ok: true as const,
    verdict: outcome.row.verdict,
    verdictId: outcome.row.id,
    recordedAt: outcome.row.recordedAt,
  };
}

/** Pure response shaping for the verdict poll (unit-tested directly). */
export function toVerdictStatusResponse(row: CompetitorGapVerdictRow | null) {
  if (!row) {
    return { verdict: null, gateState: "NO_VERDICT" as const };
  }
  return {
    verdict: row.verdict,
    gateState:
      row.verdict === "COMPETITOR_GAP_READY"
        ? ("READY" as const)
        : ("BLOCKED" as const),
    verdictId: row.id,
    recordedAt: row.recordedAt,
    evidence: row.evidence,
    thresholds: row.thresholds,
  };
}

/**
 * Maintainer spike trigger. organizationId/projectId come from context (P39)
 * — the manifest is built here, never trusted from the caller. The budget
 * pre-check refuses explicitly; paid work is bounded by the manifest cap
 * plus the router's own budget guards (P12).
 */
export const runCompetitorGapSpike = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(competitorGapSpikeInputSchema)
  .handler(async ({ context, data }) => {
    const manifest = {
      organizationId: context.organizationId,
      projectId: context.projectId,
      sampleDomains: data.sampleDomains,
      keywordSetRef: data.keywordSetRef,
      market: data.market,
      budgetCapCredits: data.budgetCapCredits,
      timeBoxHours: data.timeBoxHours,
      thresholds: data.thresholds,
    };
    try {
      const row = await runSpike({
        manifest,
        billing: {
          organizationId: context.organizationId,
          userEmail: context.userEmail,
          userId: context.userId,
          projectId: context.projectId,
        },
      });
      return toSpikeTriggerResponse({ ok: true, row });
    } catch (error) {
      if (error instanceof SpikeBudgetExceededError) {
        return toSpikeTriggerResponse({
          ok: false,
          budgetExceeded: true,
          message: error.message,
        });
      }
      throw error;
    }
  });

/** Latest verdict for the project — the auditable go/no-go surface (SC-002). */
export const getCompetitorGapVerdict = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(competitorGapVerdictStatusSchema)
  .handler(async ({ context }) => {
    const { verdictRow } = await competitorGapGateState({
      organizationId: context.organizationId,
      projectId: context.projectId,
    });
    return toVerdictStatusResponse(verdictRow);
  });