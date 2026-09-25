import {
  stableHash,
  type Finding,
  type InsightSeverity,
} from "@/shared/intelligence";
import { OPPORTUNITY_TEMPLATES } from "./opportunityTemplates";

/**
 * Pure finding→insight grouping (final-plan §11). One composer
 * (`dashboard`) with three grouping families: site detectors aggregate to
 * one insight per detectorKey, set-tier detectors aggregate keyword findings
 * per detectorKey, and entity detectors emit one insight per finding
 * (`sha8` identity). No database reads here — the composer orchestrates.
 */

export const COMPOSER_KEY = "dashboard";

// Per-entity families emit one insight per finding; every other family
// aggregates to one insight per detectorKey (site scope and keyword-set
// tier alike — a set of one still reads naturally via singular titles).
const ENTITY_DETECTORS = ["content_decay", "technical_on_important_page"];

export const IMPORTANCE_BOOST_VOLUME = 1000;
export const METRIC_DRIFT_RATIO = 0.25;
export const METRIC_DRIFT_FLOOR = 50;

export type GroupedInsight = {
  composerKey: typeof COMPOSER_KEY;
  groupKey: string;
  insightKey: string;
  detectorKey: string;
  type: string;
  findings: Finding[];
  severity: InsightSeverity;
  title: string;
  explanationFact: string;
  recommendation: string;
  entityRefs: string[];
  periods: { from: string; to: string } | null;
  sources: Finding["evidence"]["sources"];
  /** Rounded per-entity volumes (metric-drift comparison input). */
  metrics: Record<string, number>;
  findingKeys: string[];
};

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  info: 1,
};

const SEVERITY_BY_RANK: Record<number, InsightSeverity> = {
  4: "critical",
  3: "high",
  2: "medium",
  1: "info",
};

/** Max volume metric (clicks/impressions/sessions) — entity importance. */
export function importanceOf(finding: Finding): number {
  let best = 0;
  for (const [key, value] of Object.entries(finding.evidence.metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (!/clicks|impressions|sessions/i.test(key)) continue;
    if (value > best) best = value;
  }
  return best;
}

export function severityOfConfidence(confidence: number): InsightSeverity {
  if (confidence >= 85) return "critical";
  if (confidence >= 70) return "high";
  if (confidence >= 50) return "medium";
  return "info";
}

function bumpSeverity(severity: InsightSeverity): InsightSeverity {
  return SEVERITY_BY_RANK[Math.min(4, SEVERITY_RANK[severity] + 1)] ?? severity;
}

/** Jaccard similarity of two entity sets (top-5 entity drift detection). */
export function jaccard(first: string[], second: string[]): number {
  const a = new Set(first);
  const b = new Set(second);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const entry of a) {
    if (b.has(entry)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

const GROUP_RECOMMENDATIONS: Record<string, string> = {
  ranking_drop:
    "Review the listed keywords against current SERPs and confirm ranking URLs still match intent.",
  low_ctr_query:
    "Rewrite titles and meta descriptions to match query intent; re-measure over 28 days.",
  cannibalization:
    "Consolidate overlapping pages or differentiate intent signals.",
  content_decay:
    "Refresh declining pages and verify intent match against current top results.",
  technical_on_important_page:
    "Fix the listed critical issues and re-run the audit.",
  organic_traffic_change:
    "Compare the window against deployments and seasonality.",
  ga4_organic_change:
    "Compare the window against deployments, campaigns, and consent changes.",
  backlink_change:
    "Monitor for further movement before acting (two-snapshot heuristic).",
};

function groupTitle(detectorKey: string, count: number): string {
  if (count === 1) {
    if (detectorKey === "ranking_drop") return "1 important keyword lost rankings";
    if (detectorKey === "low_ctr_query") return "1 visible query has low CTR";
    if (detectorKey === "cannibalization") {
      return "1 query shows potential cannibalization";
    }
  }
  if (detectorKey === "ranking_drop") {
    return `${count} important keywords lost rankings`;
  }
  if (detectorKey === "low_ctr_query") {
    return `${count} visible queries have low CTR`;
  }
  if (detectorKey === "cannibalization") {
    return `${count} queries show potential cannibalization`;
  }
  return `${count} findings need attention`;
}

async function sha8(value: string): Promise<string> {
  return (await stableHash(value)).slice(0, 8);
}

export async function groupFindings(
  findings: Finding[],
): Promise<GroupedInsight[]> {
  const byDetector = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byDetector.get(finding.detectorKey) ?? [];
    list.push(finding);
    byDetector.set(finding.detectorKey, list);
  }
  const groups: GroupedInsight[] = [];
  for (const [detectorKey, family] of byDetector) {
    if (ENTITY_DETECTORS.includes(detectorKey)) {
      for (const finding of family) {
        groups.push(await buildGroup(detectorKey, [finding]));
      }
    } else {
      groups.push(await buildGroup(detectorKey, family));
    }
  }
  return groups.toSorted((a, b) => (a.insightKey < b.insightKey ? -1 : 1));
}

async function buildGroup(
  detectorKey: string,
  family: Finding[],
): Promise<GroupedInsight> {
  const byImportance = [...family].toSorted(
    (a, b) => importanceOf(b) - importanceOf(a),
  );
  const top = byImportance[0];
  if (!top) throw new Error(`Cannot group empty family: ${detectorKey}`);
  const isSingle = family.length === 1;
  const template = OPPORTUNITY_TEMPLATES[detectorKey];
  const title = isSingle
    ? template
      ? template.title(top)
      : top.explanationFact.slice(0, 120)
    : groupTitle(detectorKey, family.length);
  let severity: InsightSeverity = "info";
  for (const finding of family) {
    const candidate = severityOfConfidence(finding.confidenceScore);
    if (SEVERITY_RANK[candidate] > SEVERITY_RANK[severity]) {
      severity = candidate;
    }
  }
  const maxImportance = importanceOf(top);
  if (maxImportance >= IMPORTANCE_BOOST_VOLUME) {
    severity = bumpSeverity(severity);
  }
  const entityRefs = byImportance
    .slice(0, 5)
    .map((finding) => finding.entityKey);
  const groupKey = isSingleEntity(detectorKey)
    ? `${detectorKey}:${await sha8(top.entityKey)}`
    : detectorKey;
  const metrics: Record<string, number> = {};
  for (const finding of family) {
    metrics[finding.entityKey] = Math.round(importanceOf(finding));
  }
  let periods: { from: string; to: string } | null = null;
  for (const finding of family) {
    const window = finding.evidence.periods;
    if (!window) continue;
    if (!periods) {
      periods = { ...window };
    } else {
      if (window.from < periods.from) periods.from = window.from;
      if (window.to > periods.to) periods.to = window.to;
    }
  }
  const sources = [...new Set(family.flatMap((finding) => finding.evidence.sources))].toSorted();
  return {
    composerKey: COMPOSER_KEY,
    groupKey,
    insightKey: `${COMPOSER_KEY}:${groupKey}`,
    detectorKey,
    type: detectorKey,
    findings: family,
    severity,
    title,
    explanationFact: top.explanationFact,
    recommendation:
      GROUP_RECOMMENDATIONS[detectorKey] ?? "Review the linked evidence.",
    entityRefs,
    periods,
    sources,
    metrics,
    findingKeys: family.map((finding) => finding.findingKey).toSorted(),
  };
}

function isSingleEntity(detectorKey: string): boolean {
  return ENTITY_DETECTORS.includes(detectorKey);
}
