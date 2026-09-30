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

/**
 * Explicit versioned detector list — no auto-glob (mirrors the explicitness
 * of `getSeoDataRouter`). Each SEO condition has exactly one detector;
 * GA4-gated detectors land in Task 10 and register here. `striking_distance`
 * (spec 004) owns the 11–20 quick-win band.
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
