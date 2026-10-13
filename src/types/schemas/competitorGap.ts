// Spec 014 (G5/P36) — Zod trust-boundary schemas for competitor-gap spike
// server functions. Organization/project identity always comes from
// requireProjectContext (P39), never from the caller: validators only carry
// spike configuration. Bounds prevent abuse (sample-domain and credit caps).

import { z } from "zod";

const competitorGapSpikeThresholdsSchema = z
  .object({
    minKeywordCoverageRatio: z.number().min(0).max(1),
    minFirstPartyCoverageRatio: z.number().min(0).max(1),
    maxCostPerAnalysisCredits: z.number().min(0),
    repeatCacheHitRate: z.number().min(0).max(1),
    identityCollisionsAllowed: z.number().int().min(0),
  })
  .strict();

/** Spike configuration from the caller. Pre-registered BEFORE execution. */
export const competitorGapSpikeInputSchema = z
  .object({
    projectId: z.string().min(1),
    sampleDomains: z.array(z.string().min(1).max(253)).min(1).max(10),
    keywordSetRef: z.string().min(1).max(200),
    market: z
      .object({
        locationCode: z.number().int().positive(),
        languageCode: z.string().min(2).max(10),
      })
      .strict(),
    budgetCapCredits: z.number().min(1).max(10_000),
    timeBoxHours: z.number().min(0.5).max(72),
    thresholds: competitorGapSpikeThresholdsSchema,
  })
  .strict();

export type CompetitorGapSpikeInput = z.infer<
  typeof competitorGapSpikeInputSchema
>;

/** Latest-verdict poll input — project identity only. */
export const competitorGapVerdictStatusSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();

export type CompetitorGapVerdictStatusInput = z.infer<
  typeof competitorGapVerdictStatusSchema
>;