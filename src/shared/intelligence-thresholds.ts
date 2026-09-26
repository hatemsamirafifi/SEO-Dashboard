/**
 * Versioned detector thresholds (final-plan §4). Thresholds are injected into
 * detectors, never hardcoded; every threshold applied is echoed in finding
 * evidence. Default bands are reasoned priors — first production scans log
 * near-miss distributions to calibrate without code-path changes (§23.5).
 */

// Bumped 1 → 2 in PR7: low-CTR, cannibalization, and technical detectors
// gained explicit stability/importance windows (previously implicit).
// No production artifacts exist yet, so no migration is required.
export const THRESHOLD_VERSION = 2;

export type DetectorThresholds = Record<
  string,
  string | number | boolean | null
>;

/** Per-detector default thresholds, keyed by stable detectorKey. */
export const DEFAULT_DETECTOR_THRESHOLDS: Record<string, DetectorThresholds> = {
  organic_traffic_change: {
    minWindowDays: 7,
    minCoverageRatio: 0.8,
    declineRatio: 0.2,
  },
  ga4_organic_change: {
    minWindowDays: 7,
    minCoverageRatio: 0.8,
    declineRatio: 0.2,
  },
  low_ctr_query: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minImpressions: 100,
    positionBandMin: 5,
    positionBandMax: 20,
    ctrFloor: 0.01,
  },
  content_decay: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    declineRatio: 0.3,
    minVolume: 50,
    persistenceWindows: 2,
  },
  ranking_drop: {
    dropPositions: 5,
    topNTier: 20,
  },
  cannibalization: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minUrls: 2,
    minImpressions: 50,
  },
  technical_on_important_page: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    topN: 50,
    severity: "critical",
  },
  backlink_change: {
    minSnapshots: 2,
    freshnessDays: 30,
  },
};

export function defaultThresholdsFor(detectorKey: string): DetectorThresholds {
  // Spread of an absent key is a no-op ({}), so unknown detectors get an
  // empty set and fail loudly at thresholdNumber instead of silently.
  return { ...DEFAULT_DETECTOR_THRESHOLDS[detectorKey] };
}
