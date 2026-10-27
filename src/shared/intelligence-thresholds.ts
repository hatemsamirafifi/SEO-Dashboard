/**
 * Versioned detector thresholds (final-plan §4). Thresholds are injected into
 * detectors, never hardcoded; every threshold applied is echoed in finding
 * evidence. Default bands are reasoned priors — first production scans log
 * near-miss distributions to calibrate without code-path changes (§23.5).
 */

// Bumped 1 → 2 in PR7: low-CTR, cannibalization, and technical detectors
// gained explicit stability/importance windows (previously implicit).
// Bumped 2 → 3 in spec 010: conversion_drop (C2b) and engagement_drop (C2c)
// GA4-backed detectors.
// Bumped 3 → 4 in spec 014: competitor_gap detector.
// Bumped 4 → 5 in spec 018: cannibalization classification tiers
// (dominant share, intent overlap, evidence row cap).
// Bumped 5 → 6 in spec 019: SERP cluster detection thresholds.
// Bumped 6 → 7 in spec 020: AI citation gap detector.
export const THRESHOLD_VERSION = 7;
  },
// Bumped 4 → 5 in the Google Ads master plan phase 5: paid_organic_query_gap
// and paid_landing_page_technical_issue detectors.
export const THRESHOLD_VERSION = 5;

import {
  STRIKING_DISTANCE_MAX_POSITION,
  STRIKING_DISTANCE_MIN_POSITION,
} from "./intelligence";

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
  // Spec 018: classification tiers for the cannibalization detector.
  // dominantShare: one URL carries at least this share of the query's observed
  // impressions (normal URL diversity, not a conflict). intentOverlapMax: the
  // two URLs' observed query sets overlap at most this much (distinct intents).
  // maxEvidenceRows: evidence id cap - it never influences classification, and
  // row counts never decide coverage.
  cannibalization: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minUrls: 2,
    minImpressions: 50,
    dominantShare: 0.8,
    intentOverlapMax: 0.2,
    maxEvidenceRows: 200,
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
  // Spec 008: dedicated lost-backlink opportunity. Floor unit is lost
  // referring domains (never raw backlink counts — multiple links can vanish
  // from a single domain and inflate noise). Default 3 filters single-link
  // churn while surfacing meaningful losses early; tunable per conventions.
  lost_backlinks: {
    minSnapshots: 2,
    freshnessDays: 30,
    minReferringDomains: 3,
  },
  // Spec 004: 11–20 band via shared constants (echoed in evidence); the
  // impressions floor is a reasoned prior — first production scans log the
  // near-miss distribution to calibrate without code-path changes (§23.5).
  striking_distance: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minImpressions: 100,
    minPosition: STRIKING_DISTANCE_MIN_POSITION,
    maxPosition: STRIKING_DISTANCE_MAX_POSITION,
  },
  // Spec 010 (C2b): goal-scoped conversion drop. The decline prior (0.3)
  // requires a material windowed drop; the absolute floor (10 conversions in
  // the current window) keeps 2→0 noise from emitting. research.md R3.
  conversion_drop: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minEventsPerWindow: 10,
    declineRatio: 0.3,
  },
  // Spec 010 (C2c): engagement-rate drop while ranking holds. The rate is a
  // ratio-of-sums comparison so window-length differences normalize; the
  // sessions floor (100/window) keeps thin pages out; rankHoldRequired gates
  // emission on corroborated non-worsened rank (rank absent → partial-data
  // emission with capped confidence). research.md R2/R3.
  engagement_drop: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minSessionsPerWindow: 100,
    declineRatio: 0.25,
    rankHoldRequired: true,
  },
  // Spec 014: competitor keyword visibility gap against first party.
  competitor_gap: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minCompetitorRank: 10,
    maxFirstPartyPosition: 20,
    minVolume: 50,
  },
<<<<<<< HEAD
  // Spec 019: SERP pages observed together on the tracked keywords.
  // minKeywordThreshold: shared keywords before two pages form a cluster
  // (the bridge guard keeps weakly linked groups apart). minClusterPages:
  // pages a cluster needs. freshnessDays: how old an observation may be.
  serp_cluster_new_page: {
    minKeywordThreshold: 3,
    minCoverageRatio: 0.8,
    minClusterPages: 2,
    freshnessDays: 30,
  },
  // Spec 020: AI citation gaps from recorded Prompt Explorer observations.
  // freshnessDays: how old an observation may be. maxRunsRead: analysis
  // bound (NFR-002). smallSampleFloor: observations below this floor label
  // every finding small-sample with lowered confidence (FR-009).
  // frequentlyCitedMinRuns: runs a third-party domain must appear in before
  // a "frequently cited" finding emits (counted once per run).
  ai_citation_gap: {
    freshnessDays: 30,
    maxRunsRead: 200,
    smallSampleFloor: 5,
    frequentlyCitedMinRuns: 3,
=======
  // Master plan phase 5 (google-ads): paid search terms/keywords whose spend
  // (base micros, account currency) or stored conversions meet a floor while
  // organic GSC visibility is weak or absent (striking-distance band or
  // below the impression floor). Cost floors are in raw micros so they stay
  // currency-agnostic before the account currency is echoed in evidence.
  paid_organic_query_gap: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minPaidCostMicros: 500_000,
    minPaidConversions: 1,
    minOrganicImpressions: 100,
    minOrganicPosition: 11,
  },
  // Master plan phase 5 (google-ads): paid landing pages with windowed
  // spend/clicks that also carry a critical audit issue on the same
  // canonical page identity (or weak current GA4 engagement).
  paid_landing_page_technical_issue: {
    minWindowDays: 28,
    minCoverageRatio: 0.8,
    minPaidCostMicros: 500_000,
    minPaidClicks: 25,
    severity: "critical",
    weakEngagementRate: 0.4,
>>>>>>> codex/google-ads-integration
  },
};

export function defaultThresholdsFor(detectorKey: string): DetectorThresholds {
  // Spread of an absent key is a no-op ({}), so unknown detectors get an
  // empty set and fail loudly at thresholdNumber instead of silently.
  return { ...DEFAULT_DETECTOR_THRESHOLDS[detectorKey] };
}
