import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import {
  classifyKeywordFromPairFacts,
  type MissingRankingsBreakdown,
} from "@/shared/rank-tracking";

/**
 * Resolve the keyword IDs that currently have no active ranking position —
 * Ranking unavailable (CHECK_FAILED), lost, NO_RESULT, or never checked —
 * from persisted snapshot state, never from rendered UI strings.
 *
 * Eligibility is strictly pair-level, matching the table's current-state
 * rendering per (keyword, device) pair:
 * - A pair whose LATEST attempt is CHECK_FAILED is missing ("Ranking
 *   unavailable") even when the state model preserves an older valid
 *   position — the historical rank serves history/deltas, never suppression
 *   of the retry.
 * - A keyword with one ranked device and one missing device (CHECK_FAILED /
 *   lost / NO_RESULT / never checked) stays eligible: the ranked device
 *   never masks the missing one. There is deliberately NO keyword-level
 *   "any device currently ranked" complement — that loses pair semantics.
 *
 * Scope is per config (domain + location), so eligibility is inherently
 * location-specific: a keyword ranked in the UAE config is never resolved
 * from the Egypt config's snapshots.
 *
 * Returns the eligible ids plus a truthful per-bucket breakdown.
 */
export async function resolveMissingRankingKeywordIds(input: {
  configId: string;
  devices: RankTrackingConfig["devices"];
  /** Restrict resolution to these ids (selection mode). */
  keywordIds?: string[];
}): Promise<{
  eligibleIds: string[];
  breakdown: MissingRankingsBreakdown;
}> {
  const configKeywords = await RankTrackingRepository.getKeywordsForConfig(
    input.configId,
  );
  if (configKeywords.length === 0) {
    return { eligibleIds: [], breakdown: emptyBreakdown() };
  }

  let candidateIds = configKeywords.map((kw) => kw.id);
  if (input.keywordIds && input.keywordIds.length > 0) {
    const requested = new Set(input.keywordIds);
    candidateIds = candidateIds.filter((id) => requested.has(id));
    if (candidateIds.length === 0) {
      return { eligibleIds: [], breakdown: emptyBreakdown() };
    }
  }

  const facts = await RankTrackingRepository.getLatestRankingFactsForConfig(
    input.configId,
    candidateIds,
  );

  const breakdown = emptyBreakdown();
  const eligibleIds: string[] = [];

  for (const id of candidateIds) {
    const classification = classifyKeywordFromPairFacts(
      facts,
      id,
      input.devices,
    );
    if (!classification.eligible || !classification.bucket) continue;

    eligibleIds.push(id);
    breakdown[classification.bucket] += 1;
  }

  return { eligibleIds, breakdown };
}

export function emptyBreakdown(): MissingRankingsBreakdown {
  return { ranking_unavailable: 0, lost: 0, no_ranking: 0 };
}

/** Truthful eligible count + bucket breakdown for the confirmation UI. */
export async function getMissingRankingsSummary(input: {
  configId: string;
  projectId: string;
  keywordIds?: string[];
}): Promise<{
  total: number;
  eligibleCount: number;
  breakdown: MissingRankingsBreakdown;
}> {
  const config = await getValidatedConfig(input.configId, input.projectId);

  let requested = input.keywordIds;
  if (requested && requested.length > 0) {
    // Same membership validation as triggerCheck: only ids tracked on this
    // config survive, deduplicated.
    const configKeywordIds = new Set(
      (await RankTrackingRepository.getKeywordsForConfig(config.id)).map(
        (kw) => kw.id,
      ),
    );
    const seen = new Set<string>();
    requested = requested.filter((id) => {
      if (seen.has(id) || !configKeywordIds.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  const total =
    requested && requested.length > 0
      ? requested.length
      : await RankTrackingRepository.getKeywordCountForConfig(config.id);

  const { eligibleIds, breakdown } = await resolveMissingRankingKeywordIds({
    configId: config.id,
    devices: config.devices,
    keywordIds: requested,
  });

  return {
    total,
    eligibleCount: eligibleIds.length,
    breakdown,
  };
}

async function getValidatedConfig(configId: string, projectId: string) {
  const config = await RankTrackingRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("INTERNAL_ERROR", "Rank tracking config not found");
  }
  return config;
}
