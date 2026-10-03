import type { DetectorContext } from "./types";
import { fetchGa4ChangeInput } from "./ga4OrganicChange";
import { fetchTrafficChangeInput } from "./organicTrafficChange";
import { fetchLowCtrInput } from "./lowCtrQuery";
import { fetchDecayInput } from "./contentDecay";
import { fetchRankDropInput } from "./rankingDrop";
import { fetchCannibalizationInput } from "./cannibalization";
import { fetchTechnicalInput } from "./technicalOnImportantPage";
import { fetchBacklinkChangeInput } from "./backlinkChange";
import { fetchLostBacklinksInput } from "./lostBacklinks";
import { fetchStrikingDistanceInput } from "./strikingDistance";
import { fetchConversionDropInput } from "./conversionDrop";
import { fetchEngagementDropInput } from "./engagementDrop";

/**
 * Explicit per-detector input dispatcher (final-plan §4: detectors run over
 * pre-fetched inputs, never live repository reads). Each fetcher assembles
 * its detector's windowed input plus grain-level coverage, throwing
 * `InsufficientCoverageError` when required coverage is missing (recorded as
 * `skipped`) — distinct from detector bugs (recorded as `failed`).
 * Unknown keys return null, preserving the "no input fetcher" skip path.
 */
export async function fetchDetectorInput(
  detectorKey: string,
  projectId: string,
  ctx: DetectorContext,
): Promise<unknown> {
  switch (detectorKey) {
    case "ga4_organic_change":
      return fetchGa4ChangeInput(projectId, ctx);
    case "organic_traffic_change":
      return fetchTrafficChangeInput(projectId, ctx);
    case "low_ctr_query":
      return fetchLowCtrInput(projectId, ctx);
    case "content_decay":
      return fetchDecayInput(projectId, ctx);
    case "ranking_drop":
      return fetchRankDropInput(projectId, ctx);
    case "cannibalization":
      return fetchCannibalizationInput(projectId, ctx);
    case "technical_on_important_page":
      return fetchTechnicalInput(projectId, ctx);
    case "backlink_change":
      return fetchBacklinkChangeInput(projectId, ctx);
    case "lost_backlinks":
      return fetchLostBacklinksInput(projectId, ctx);
    case "striking_distance":
      return fetchStrikingDistanceInput(projectId, ctx);
    case "conversion_drop":
      return fetchConversionDropInput(projectId, ctx);
    case "engagement_drop":
      return fetchEngagementDropInput(projectId, ctx);
    default:
      return null;
  }
}
