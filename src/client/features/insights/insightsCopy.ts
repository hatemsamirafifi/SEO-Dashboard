/**
 * Pure view-model and metadata helpers for composed dashboard insights
 * (final-plan §§11/17). Sections group stored insight rows by detector
 * family; behavior is covered through these helpers (no jsdom in the repo).
 */

export const INSIGHT_SECTIONS = [
  "seo-performance",
  "search-visibility",
  "traffic-engagement",
  "conversions",
  "opportunities-top",
  "technical-health",
  "backlinks",
  "recent-changes",
] as const;
export type InsightSectionId = (typeof INSIGHT_SECTIONS)[number];

export const SECTION_META: Record<
  InsightSectionId,
  { title: string; description: string }
> = {
  "seo-performance": {
    title: "SEO Performance",
    description: "Site-level traffic movements.",
  },
  "search-visibility": {
    title: "Search Visibility",
    description: "Rankings, CTR, and cannibalization.",
  },
  "traffic-engagement": {
    title: "Traffic & Engagement",
    description: "Sustained page-level changes.",
  },
  conversions: {
    title: "Conversions",
    description: "Conversion insights.",
  },
  "opportunities-top": {
    title: "Top Opportunities",
    description: "Highest-priority open actions.",
  },
  "technical-health": {
    title: "Technical Health",
    description: "Critical issues on important pages.",
  },
  backlinks: { title: "Backlinks", description: "Link profile movement." },
  "recent-changes": {
    title: "Recent Changes",
    description: "Most recently detected insights.",
  },
};

const DETECTOR_SECTIONS: Record<string, InsightSectionId> = {
  organic_traffic_change: "seo-performance",
  ga4_organic_change: "seo-performance",
  ranking_drop: "search-visibility",
  low_ctr_query: "search-visibility",
  cannibalization: "search-visibility",
  content_decay: "traffic-engagement",
  technical_on_important_page: "technical-health",
  backlink_change: "backlinks",
};

/** Section for an insight's detector family; null when unmapped. */
export function sectionForDetector(
  detectorKey: string,
): InsightSectionId | null {
  return DETECTOR_SECTIONS[detectorKey] ?? null;
}

export const INSIGHT_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "info",
] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

export const SEVERITY_META: Record<
  InsightSeverity,
  { label: string; badgeClass: string }
> = {
  critical: { label: "Critical", badgeClass: "badge-error" },
  high: { label: "High", badgeClass: "badge-warning" },
  medium: { label: "Medium", badgeClass: "badge-info" },
  info: { label: "Info", badgeClass: "badge-ghost" },
};

function isSeverityValue(value: string): value is InsightSeverity {
  return (INSIGHT_SEVERITIES as readonly string[]).includes(value);
}

/** Badge-safe lookups: unknown future values render neutrally. */
export function severityLabel(severity: string): string {
  return isSeverityValue(severity) ? SEVERITY_META[severity].label : severity;
}

export function severityBadgeClass(severity: string): string {
  return `badge ${isSeverityValue(severity) ? SEVERITY_META[severity].badgeClass : "badge-ghost"} badge-sm`;
}

export type SectionInsightRow = {
  id: string;
  insightKey: string;
  detectorKey: string;
  severity: string;
  detectedAt: string;
};

/** Groups visible insights by section; unmapped families appear only in
 *  recent-changes (never silently dropped from the page). */
export function groupInsightsBySection<Row extends SectionInsightRow>(
  rows: Row[],
): Record<InsightSectionId, Row[]> {
  const grouped: Record<InsightSectionId, Row[]> = {
    "seo-performance": [],
    "search-visibility": [],
    "traffic-engagement": [],
    conversions: [],
    "opportunities-top": [],
    "technical-health": [],
    backlinks: [],
    "recent-changes": [],
  };
  for (const row of rows) {
    const section = sectionForDetector(row.detectorKey);
    if (
      section &&
      section !== "recent-changes" &&
      section !== "opportunities-top"
    ) {
      grouped[section].push(row);
    }
  }
  grouped["recent-changes"] = [...rows].toSorted((a, b) =>
    a.detectedAt < b.detectedAt ? 1 : -1,
  );
  return grouped;
}

/** Snooze target for the "snooze a week" action (ISO date, 7 days out). */
export function snoozeWeekFrom(nowMs: number): string {
  return new Date(nowMs + 7 * 86_400_000).toISOString();
}
