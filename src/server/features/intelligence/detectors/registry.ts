import type { DetectorDef } from "./types";
import { ga4OrganicChangeDetector } from "./ga4OrganicChange";
import { organicTrafficChangeDetector } from "./organicTrafficChange";
import { lowCtrQueryDetector } from "./lowCtrQuery";
import { contentDecayDetector } from "./contentDecay";
import { rankingDropDetector } from "./rankingDrop";
import { cannibalizationDetector } from "./cannibalization";
import { technicalOnImportantPageDetector } from "./technicalOnImportantPage";
import { backlinkChangeDetector } from "./backlinkChange";
import { lostBacklinksDetector } from "./lostBacklinks";
import { strikingDistanceDetector } from "./strikingDistance";
import { conversionDropDetector } from "./conversionDrop";
import { engagementDropDetector } from "./engagementDrop";

/**
 * Explicit versioned detector list — no auto-glob (mirrors the explicitness
 * of `getSeoDataRouter`). Each SEO condition has exactly one detector;
 * `striking_distance` (spec 004) owns the 11–20 quick-win band;
 * `conversion_drop` + `engagement_drop` (spec 010) own the GA4-backed
 * conversion/engagement conditions.
 */
const DETECTORS: DetectorDef[] = [
  ga4OrganicChangeDetector,
  organicTrafficChangeDetector,
  lowCtrQueryDetector,
  contentDecayDetector,
  rankingDropDetector,
  cannibalizationDetector,
  technicalOnImportantPageDetector,
  backlinkChangeDetector,
  lostBacklinksDetector,
  strikingDistanceDetector,
  conversionDropDetector,
  engagementDropDetector,
];

export function listDetectors(): DetectorDef[] {
  return [...DETECTORS];
}

export function getDetector(detectorKey: string): DetectorDef | null {
  return (
    DETECTORS.find((detector) => detector.detectorKey === detectorKey) ?? null
  );
}

/** Registry identity snapshot pinned into run input hashes. */
export function detectorVersions(): Record<string, number> {
  return Object.fromEntries(
    DETECTORS.map((detector) => [detector.detectorKey, detector.version]),
  );
}
