import type { DetectorDef } from "./types";

/**
 * Explicit versioned detector list — no auto-glob (mirrors the explicitness
 * of `getSeoDataRouter`). Each SEO condition has exactly one detector;
 * detectors land in Tasks 7/10 and register here. The list ships empty in
 * Task 6 so the Stage-1 scan path, artifact flow, and scheduler are proven
 * before any detector exists.
 */
const DETECTORS: DetectorDef[] = [];

export function listDetectors(): DetectorDef[] {
  return [...DETECTORS];
}

export function getDetector(detectorKey: string): DetectorDef | null {
  return DETECTORS.find((detector) => detector.detectorKey === detectorKey) ?? null;
}

/** Registry identity snapshot pinned into run input hashes. */
export function detectorVersions(): Record<string, number> {
  return Object.fromEntries(
    DETECTORS.map((detector) => [detector.detectorKey, detector.version]),
  );
}
