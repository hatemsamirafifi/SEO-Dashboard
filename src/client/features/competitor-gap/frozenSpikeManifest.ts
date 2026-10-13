// Spec 014: Frozen Competitor-Gap Spike Manifest Constant
// Generated verbatim from specs/014-competitor-gap-conditional/spike-manifest.md §9.
// IMMUTABLE: Must never be altered or mutated at runtime.

import type { CompetitorGapSpikeInput } from "@/types/schemas/competitorGap";

export type FrozenCompetitorGapSpikeManifest = Readonly<
  Omit<CompetitorGapSpikeInput, "sampleDomains"> & {
    sampleDomains: readonly string[];
  }
>;

export const FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST: FrozenCompetitorGapSpikeManifest =
  Object.freeze({
    projectId: "bb267736-5e5e-9f5f-7d78260abbde",
    sampleDomains: Object.freeze(["emtyiaz.com", "manaraa.com", "bahthy.com"]),
    keywordSetRef: "gsc-top-queries-2026-10-09",
    market: Object.freeze({
      locationCode: 2784,
      languageCode: "ar",
    }),
    budgetCapCredits: 500,
    timeBoxHours: 4,
    thresholds: Object.freeze({
      minKeywordCoverageRatio: 0.5,
      minFirstPartyCoverageRatio: 0.5,
      maxCostPerAnalysisCredits: 100,
      repeatCacheHitRate: 1.0,
      identityCollisionsAllowed: 0,
    }),
  });
