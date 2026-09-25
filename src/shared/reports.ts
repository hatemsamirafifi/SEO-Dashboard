import { z } from "zod";

/**
 * Report payload contract (final-plan §§12/14). One frozen shape; the five
 * report types are section selectors over it (no per-type forks). Renderers
 * (Web now; PDF/public-share/MCP later) consume `ReportPayload` and render
 * the consistency banner through `consistencyBanner` so the string is
 * identical everywhere.
 */

export const REPORT_PAYLOAD_VERSION = 1;

export const REPORT_TYPES = [
  "overview",
  "search_performance",
  "rank_tracking",
  "technical",
  "executive",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const reportTypeSchema = z.enum(REPORT_TYPES);

export const REPORT_SECTIONS = [
  "search_visibility",
  "traffic",
  "conversions",
  "rankings",
  "technical",
  "backlinks",
  "opportunities",
  "insights",
] as const;
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number];

/** Section mapping per report type — the only place types differ. */
export const REPORT_TYPE_SECTIONS: Record<ReportType, ReportSectionKey[]> = {
  overview: [...REPORT_SECTIONS],
  search_performance: ["search_visibility", "insights", "opportunities"],
  rank_tracking: ["rankings", "insights", "opportunities"],
  technical: ["technical", "insights", "opportunities"],
  executive: [
    "search_visibility",
    "traffic",
    "opportunities",
    "insights",
  ],
};

export function sectionsForReportType(type: ReportType): ReportSectionKey[] {
  return REPORT_TYPE_SECTIONS[type];
}

export const CONSISTENCY_STATUSES = [
  "consistent",
  "concurrent_mutation",
] as const;
export type ConsistencyStatus = (typeof CONSISTENCY_STATUSES)[number];

export const reportProvenanceSchema = z.object({
  consistencyStatus: z.enum(CONSISTENCY_STATUSES),
  /** Frozen source-state hash — present only when before==after. */
  metricSourceVersions: z.string().nullable(),
  /** Only on mutation: the two states that disagreed. */
  collectionVersionsBefore: z.string().nullable(),
  collectionVersionsAfter: z.string().nullable(),
  intelligenceRunId: z.string().nullable(),
  intelligenceRunHash: z.string().nullable(),
  intelligenceManifestHash: z.string().nullable(),
  intelligenceCompletedAt: z.string().nullable(),
  hasSuccessfulScan: z.boolean(),
  /** Stale-but-stable (>24h) generates with this label, never blocks. */
  intelligenceStale: z.boolean(),
  generatedAt: z.string(),
});
export type ReportProvenance = z.infer<typeof reportProvenanceSchema>;

/**
 * The single consistency banner string. Every renderer (Web, PDF,
 * public-share, MCP) calls this — never its own copy.
 */
export function consistencyBanner(provenance: ReportProvenance): string {
  const base =
    provenance.consistencyStatus === "consistent"
      ? "All data sources were stable while this report was collected."
      : "Some data changed while this report was collected; figures may mix two states.";
  if (!provenance.hasSuccessfulScan) {
    return `${base} No successful intelligence scan exists yet; insights and opportunities reflect whatever has been composed so far.`;
  }
  if (provenance.intelligenceStale) {
    return `${base} Intelligence is stale (last successful scan ${provenance.intelligenceCompletedAt}).`;
  }
  return base;
}

const metricAvailabilitySchema = z.object({
  available: z.boolean(),
  /** Set when unavailable: not_connected | provider_failed | no_coverage. */
  reason: z.string().nullable(),
});

const gscTotalsSchema = z.object({
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});

const ga4TotalsSchema = z.object({
  sessions: z.number(),
  engagedSessions: z.number(),
  screenPageViews: z.number(),
  eventCount: z.number(),
  newUsers: z.number(),
  keyEvents: z.number(),
  totalRevenue: z.number(),
  transactions: z.number(),
});

export const reportPayloadSchema = z.object({
  version: z.literal(REPORT_PAYLOAD_VERSION),
  reportType: reportTypeSchema,
  sections: z.array(z.enum(REPORT_SECTIONS)),
  period: z.object({ from: z.string(), to: z.string() }),
  generatedAt: z.string(),
  searchVisibility: z.object({
    status: metricAvailabilitySchema,
    totals: gscTotalsSchema.nullable(),
  }),
  traffic: z.object({
    status: metricAvailabilitySchema,
    totals: ga4TotalsSchema.nullable(),
  }),
  conversions: z.object({
    status: metricAvailabilitySchema,
    keyEvents: z.number().nullable(),
    transactions: z.number().nullable(),
  }),
  rankings: z.object({
    status: metricAvailabilitySchema,
    trackedKeywords: z.number().nullable(),
    improved: z.number().nullable(),
    declined: z.number().nullable(),
    top10: z.number().nullable(),
    lastCheckedAt: z.string().nullable(),
  }),
  technical: z.object({
    status: metricAvailabilitySchema,
    auditStatus: z.string().nullable(),
    pagesCrawled: z.number().nullable(),
    topIssues: z
      .array(
        z.object({
          issueType: z.string(),
          severity: z.string(),
          count: z.number(),
        }),
      )
      .nullable(),
  }),
  backlinks: z.object({
    status: metricAvailabilitySchema,
    referringDomains: z.number().nullable(),
    capturedAt: z.string().nullable(),
  }),
  opportunities: z.array(
    z.object({
      id: z.string(),
      logicalKey: z.string(),
      type: z.string(),
      status: z.string(),
      priority: z.string(),
      impactScore: z.number(),
      confidenceScore: z.number(),
      title: z.string(),
      explanationFact: z.string(),
      recommendation: z.string(),
      completedAt: z.string().nullable(),
    }),
  ),
  insights: z.array(
    z.object({
      insightKey: z.string(),
      type: z.string(),
      detectorKey: z.string(),
      severity: z.string(),
      title: z.string(),
      explanationFact: z.string(),
      recommendation: z.string().nullable(),
      detectedAt: z.string(),
      contentVersion: z.number(),
    }),
  ),
  provenance: reportProvenanceSchema,
});
export type ReportPayload = z.infer<typeof reportPayloadSchema>;
