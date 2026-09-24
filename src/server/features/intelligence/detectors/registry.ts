import type { DetectorDef } from "./types";
import { organicTrafficChangeDetector } from "./organicTrafficChange";
import { lowCtrQueryDetector } from "./lowCtrQuery";
import { contentDecayDetector } from "./contentDecay";
import { rankingDropDetector } from "./rankingDrop";
import { cannibalizationDetector } from "./cannibalization";
import { technicalOnImportantPageDetector } from "./technicalOnImportantPage";
import { backlinkChangeDetector } from "./backlinkChange";

/**
 * Explicit versioned detector list — no auto-glob (mirrors the explicitness
 * of `getSeoDataRouter`). Each SEO condition has exactly one detector;
 * GA4-gated detectors land in Task 10 and register here.
 */
const DETECTORS: DetectorDef[] = [
  organicTrafficChangeDetector,
  lowCtrQueryDetector,
  contentDecayDetector,
  rankingDropDetector,
  cannibalizationDetector,
  technicalOnImportantPageDetector,
  backlinkChangeDetector,
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
