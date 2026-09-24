import { OPPORTUNITY_WEIGHTS } from "@/shared/opportunity-weights";
import {
  renormalizedScore,
  type Finding,
  type ScoredFactor,
} from "@/shared/intelligence";

/**
 * Per-detectorKey materialization templates (final-plan §4: recommendations
 * come exclusively from the materializer, never detectors). Each template
 * maps frozen finding evidence to opportunity identity copy, actionable
 * correlation-only prose, entity refs, and impact-factor inputs.
 *
 * Impact normalizers (documented, deterministic, 0–1):
 * - trafficPotential = min(1, log10(1+volume)/5) — 100k volume saturates.
 * - proximity = max(0, 1-(position-1)/20) — top-20 band fades to zero.
 * - decline = min(1, |change|/0.5) — 50% moves saturate (mirrors §10).
 * - businessIntent/conversionSignal are unavailable for all PR7 detectors:
 *   Stage 2 forbids source-metric reads, and no GA4/keyword evidence ships
 *   in PR7 findings — the divisor shrinks instead of scoring zero
 *   (renormalizedScore). They activate with GA4/keyword evidence later.
 */

export type ImpactFactors = {
  trafficPotential: number | null;
  proximity: number | null;
  decline: number | null;
  businessIntent: null;
  conversionSignal: null;
};

export function logScaleVolume(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  return Math.min(1, Math.log10(1 + volume) / 5);
}

export function proximityOf(position: number): number {
  if (!Number.isFinite(position) || position < 1) return 0;
  return Math.max(0, 1 - (position - 1) / 20);
}

export function declineOf(changeRatio: number): number {
  if (!Number.isFinite(changeRatio)) return 0;
  return Math.min(1, Math.abs(changeRatio) / 0.5);
}

function metricNumber(
  metrics: Record<string, string | number | boolean>,
  key: string,
): number | null {
  const value: unknown = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type OpportunityTemplate = {
  type: string;
  title: (finding: Finding) => string;
  recommendation: (finding: Finding) => string;
  keywordOf: (finding: Finding) => string | null;
  pageOf: (finding: Finding) => string | null;
  factorsOf: (finding: Finding) => ImpactFactors;
};

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export const OPPORTUNITY_TEMPLATES: Record<string, OpportunityTemplate> = {
  organic_traffic_change: {
    type: "traffic",
    title: (finding) => {
      const before = metricNumber(finding.evidence.metrics, "clicksBefore") ?? 0;
      const after = metricNumber(finding.evidence.metrics, "clicksAfter") ?? 0;
      const ratio = metricNumber(finding.evidence.metrics, "changeRatio") ?? 0;
      const direction = ratio < 0 ? "fell" : "grew";
      return (
        `Organic clicks ${direction} ${Math.abs(ratio * 100).toFixed(1)}% ` +
        `(${formatInt(before)} → ${formatInt(after)})`
      );
    },
    recommendation: () =>
      "Compare the window against deployments, seasonality, and Search " +
      "Console query data to identify which pages changed; prioritize the " +
      "largest absolute click movers first.",
    keywordOf: () => null,
    pageOf: () => null,
    factorsOf: (finding) => ({
      trafficPotential: logScaleVolume(
        metricNumber(finding.evidence.metrics, "clicksAfter") ?? 0,
      ),
      proximity: null,
      decline: declineOf(
        metricNumber(finding.evidence.metrics, "changeRatio") ?? 0,
      ),
      businessIntent: null,
      conversionSignal: null,
    }),
  },
  low_ctr_query: {
    type: "ctr",
    title: (finding) => {
      const query = finding.entity.query;
      const position = metricNumber(finding.evidence.metrics, "position") ?? 0;
      return (
        `Low CTR for "${typeof query === "string" ? query : finding.entityKey}" ` +
        `at position ${position.toFixed(1)}`
      );
    },
    recommendation: () =>
      "Rewrite the title and meta description to match the query intent; " +
      "change one element at a time and re-measure CTR over the next 28 days.",
    keywordOf: (finding) => {
      const query = finding.entity.query;
      return typeof query === "string" ? query : finding.entityKey;
    },
    pageOf: () => null,
    factorsOf: (finding) => ({
      trafficPotential: logScaleVolume(
        metricNumber(finding.evidence.metrics, "impressions") ?? 0,
      ),
      proximity: proximityOf(
        metricNumber(finding.evidence.metrics, "position") ?? 0,
      ),
      decline: null,
      businessIntent: null,
      conversionSignal: null,
    }),
  },
  content_decay: {
    type: "decay",
    title: (finding) => {
      const page = finding.entity.page;
      return `Sustained click decline on ${typeof page === "string" ? page : finding.entityKey}`;
    },
    recommendation: () =>
      "Refresh the page content, verify intent match against current top " +
      "results, and check for internal-link or technical regressions in the " +
      "same window.",
    keywordOf: () => null,
    pageOf: (finding) => {
      const page = finding.entity.page;
      return typeof page === "string" ? page : null;
    },
    factorsOf: (finding) => ({
      trafficPotential: logScaleVolume(
        metricNumber(finding.evidence.metrics, "clicksCurrent") ?? 0,
      ),
      proximity: null,
      decline: declineOf(
        metricNumber(finding.evidence.metrics, "declineRatio") ?? 0,
      ),
      businessIntent: null,
      conversionSignal: null,
    }),
  },
  ranking_drop: {
    type: "ranking",
    title: (finding) => {
      const keyword = finding.entity.keyword;
      const drop = metricNumber(finding.evidence.metrics, "dropPositions") ?? 0;
      const device = finding.entity.device;
      return (
        `"${typeof keyword === "string" ? keyword : finding.entityKey}" dropped ` +
        `${Math.round(drop)} positions` +
        `${typeof device === "string" ? ` (${device})` : ""}`
      );
    },
    recommendation: () =>
      "Inspect the SERP for the keyword, confirm the ranking URL still " +
      "matches intent, and review on-page relevance and internal links.",
    keywordOf: (finding) => {
      const keyword = finding.entity.keyword;
      return typeof keyword === "string" ? keyword : null;
    },
    pageOf: (finding) => {
      const url = finding.entity.url;
      return typeof url === "string" ? url : null;
    },
    factorsOf: (finding) => ({
      trafficPotential: null,
      proximity: proximityOf(
        metricNumber(finding.evidence.metrics, "positionBefore") ?? 0,
      ),
      decline: Math.min(
        1,
        (metricNumber(finding.evidence.metrics, "dropPositions") ?? 0) / 10,
      ),
      businessIntent: null,
      conversionSignal: null,
    }),
  },
  cannibalization: {
    type: "cannibalization",
    title: (finding) => {
      const query = finding.entity.query;
      return `Potential cannibalization for "${typeof query === "string" ? query : finding.entityKey}"`;
    },
    recommendation: () =>
      "Consolidate overlapping pages or differentiate their intent and " +
      "internal anchor signals; monitor which URL stabilizes.",
    keywordOf: (finding) => {
      const query = finding.entity.query;
      return typeof query === "string" ? query : null;
    },
    pageOf: () => null,
    factorsOf: (finding) => ({
      trafficPotential: logScaleVolume(
        metricNumber(finding.evidence.metrics, "queryImpressions") ?? 0,
      ),
      proximity: null,
      decline: null,
      businessIntent: null,
      conversionSignal: null,
    }),
  },
  technical_on_important_page: {
    type: "technical",
    title: (finding) => {
      const issueType = finding.entity.issueType;
      const page = finding.entity.page;
      return (
        `Critical ${typeof issueType === "string" ? issueType : "issue"} on ` +
        `${typeof page === "string" ? page : finding.entityKey}`
      );
    },
    recommendation: (finding) => {
      const issueType = finding.entity.issueType;
      return (
        `Fix the ${typeof issueType === "string" ? issueType : "issue"} issue ` +
        "on the page and re-run the audit to confirm resolution."
      );
    },
    keywordOf: () => null,
    pageOf: (finding) => {
      const page = finding.entity.page;
      return typeof page === "string" ? page : null;
    },
    factorsOf: (finding) => ({
      trafficPotential: logScaleVolume(
        metricNumber(finding.evidence.metrics, "pageClicks") ?? 0,
      ),
      proximity: null,
      decline: null,
      businessIntent: null,
      conversionSignal: null,
    }),
  },
  backlink_change: {
    type: "backlinks",
    title: (finding) => {
      const domain = finding.entity.domain;
      return `Backlink movement for ${typeof domain === "string" ? domain : finding.entityKey} (heuristic)`;
    },
    recommendation: () =>
      "Review lost referring domains for reclaim opportunities and monitor " +
      "for further movement before acting (two-snapshot heuristic).",
    keywordOf: () => null,
    pageOf: () => null,
    factorsOf: (finding) => {
      // Reconstruct the pre-move base: after-totals plus what was lost.
      const backlinksBase =
        Math.max(
          0,
          metricNumber(finding.evidence.metrics, "referringDomainsAfter") ?? 0,
        ) +
        Math.max(
          0,
          (metricNumber(finding.evidence.metrics, "backlinksDelta") ?? 0) +
            (metricNumber(finding.evidence.metrics, "lostBacklinks") ?? 0),
        );
      const lost =
        (metricNumber(finding.evidence.metrics, "lostBacklinks") ?? 0) +
        (metricNumber(finding.evidence.metrics, "lostReferringDomains") ?? 0);
      return {
        trafficPotential: logScaleVolume(backlinksBase),
        proximity: null,
        decline:
          backlinksBase > 0
            ? Math.min(1, lost / backlinksBase / 0.1)
            : null,
        businessIntent: null,
        conversionSignal: null,
      };
    },
  },
};

/** Impact score via the shared renormalizer; null = no materialization. */
export function scoreImpact(factors: ImpactFactors): number | null {
  const scored: ScoredFactor[] = [
    { weight: OPPORTUNITY_WEIGHTS.trafficPotential, value: factors.trafficPotential },
    { weight: OPPORTUNITY_WEIGHTS.proximity, value: factors.proximity },
    { weight: OPPORTUNITY_WEIGHTS.decline, value: factors.decline },
    { weight: OPPORTUNITY_WEIGHTS.businessIntent, value: factors.businessIntent },
    { weight: OPPORTUNITY_WEIGHTS.conversionSignal, value: factors.conversionSignal },
  ];
  return renormalizedScore(scored);
}

export type DecayConfidenceInputs = {
  coverage: number;
  volume: number;
  magnitude: number;
  persistence: number;
  rankSessionMoves: number;
  entityConsistency: number;
  truncationStatus: number;
  agreement: number;
};

/**
 * Content-decay opportunity confidence (final-plan §10 capped multi-input
 * function). Rank/session moves absent → 0.5 neutral; directional agreement
 * weighs 0.10 + shares the rank signal with rankSessionMoves at 0.05, so
 * rank-driven contribution caps at exactly 15 points — agreement alone can
 * never reach High. Volume below the floor suppresses (returns null).
 */
export function decayConfidence(finding: Finding): {
  score: number | null;
  inputs: DecayConfidenceInputs;
} | null {
  const inputs = finding.evidence.confidenceInputs;
  const thresholds = finding.evidence.thresholdsApplied;
  const metrics = finding.evidence.metrics;
  const num = (
    record: Record<string, string | number | boolean>,
    key: string,
  ): number | null => {
    const value: unknown = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const decline = num(metrics, "declineRatio") ?? 0;
  const baseline = num(metrics, "clicksPrevious") ?? 0;
  const floor = num(thresholds, "minVolume") ?? 50;
  if (baseline < floor) return null;
  const dayRatio = num(inputs, "coverageDayRatio") ?? 1;
  const rankAgrees = inputs.rankAgrees === true;
  const rankUnavailable =
    finding.evidence.partialData.includes("rank_corroboration_unavailable");
  const moves = rankAgrees ? 1 : rankUnavailable ? 0.5 : 0;
  const confidenceInputs: DecayConfidenceInputs = {
    coverage: Math.min(1, Math.max(0, dayRatio)),
    volume: Math.min(1, baseline / 500),
    magnitude: Math.min(1, Math.abs(decline) / 0.5),
    persistence: 1,
    rankSessionMoves: moves,
    entityConsistency: 1,
    truncationStatus: Math.min(1, Math.max(0, dayRatio)),
    agreement: moves,
  };
  const score = Math.round(
    100 *
      (0.3 * confidenceInputs.magnitude +
        0.2 * confidenceInputs.persistence +
        0.15 * confidenceInputs.coverage +
        0.1 * confidenceInputs.volume +
        0.05 * confidenceInputs.rankSessionMoves +
        0.05 * confidenceInputs.entityConsistency +
        0.05 * confidenceInputs.truncationStatus +
        0.1 * confidenceInputs.agreement),
  );
  return { score, inputs: confidenceInputs };
}
