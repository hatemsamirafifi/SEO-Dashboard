// Spec 014 (G5/P36) — thin server functions for the competitor-gap input
// spike (Part A, the only unconditional part of this package).
//
// Layering (P1): authentication + project context + strict input validation
// happen here; measurement, verdict evaluation, and persistence live in
// src/server/lib/competitor-gap/. The verdict ledger row is the durable
// gate consumed by future Part B/C code paths.

import { createServerFn } from "@tanstack/react-start";
import {
  allVerdictsForProject,
  checkSpikeExecutionEligibility,
  latestVerdict,
} from "@/server/lib/competitor-gap/verdictLedger";
import { getProjectMarket } from "@/server/lib/seo-data/competitor-snapshot-repository";
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
export function toVerdictStatusResponse(
  row: CompetitorGapVerdictRow | null,
  previousRow?: CompetitorGapVerdictRow | null,
) {
  const previousVerdict = previousRow
    ? {
        verdict: previousRow.verdict,
        verdictId: previousRow.id,
        recordedAt: previousRow.recordedAt,
      }
    : null;

  if (!row) {
    return {
      verdict: null,
      gateState: "NO_VERDICT" as const,
      previousVerdict,
    };
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
    previousVerdict,
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
    const eligibility = checkSpikeExecutionEligibility({
      evaluationId: data.evaluationId,
    });
    if (!eligibility.eligible) {
      return toSpikeTriggerResponse({
        ok: false,
        budgetExceeded: true,
        message: eligibility.reason,
      });
    }

    const manifest = {
      organizationId: context.organizationId,
      projectId: context.projectId,
      evaluationId: data.evaluationId,
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
  .handler(async ({ context, data }) => {
    const projectMarket = await getProjectMarket(context.projectId);
    const verdictRow = await latestVerdict({
      organizationId: context.organizationId,
      projectId: context.projectId,
      evaluationId: data?.evaluationId,
      market: projectMarket ?? undefined,
    });
    const allRows = await allVerdictsForProject({
      organizationId: context.organizationId,
      projectId: context.projectId,
    });
    const previousRow =
      allRows.find(
        (r) => r.inputManifest.evaluationId !== data?.evaluationId,
      ) ?? null;

    return toVerdictStatusResponse(verdictRow, previousRow);
  });
