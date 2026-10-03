import { z } from "zod";

/**
 * Report payload contract (final-plan §§12/14). One frozen shape; the five
 * report types are section selectors over it (no per-type forks). Renderers
 * (Web now; PDF/public-share/MCP later) consume `ReportPayload` and render
 * the consistency banner through `consistencyBanner` so the string is
 * identical everywhere.
 */

export const REPORT_PAYLOAD_VERSION = 1;

/** Scheduled delivery cadences (spec 012, D2b MVP set — weekly/monthly only).
 *  Daily/quarterly/custom crontab cadences are out of scope. */
export const REPORT_SCHEDULE_CADENCES = ["weekly", "monthly"] as const;
export type ReportScheduleCadence = (typeof REPORT_SCHEDULE_CADENCES)[number];
export const reportScheduleCadenceSchema = z.enum(REPORT_SCHEDULE_CADENCES);

/** Schedule-run ledger states (spec 012, P33). Terminal: delivered,
 *  partially_delivered, failed, skipped. Non-terminal: claimed, generating,
 *  delivering. Succeeded runs are never re-entered. */
export const REPORT_SCHEDULE_RUN_STATES = [
  "claimed",
  "generating",
  "delivering",
  "delivered",
  "partially_delivered",
  "failed",
  "skipped",
] as const;
export type ReportScheduleRunState =
  (typeof REPORT_SCHEDULE_RUN_STATES)[number];
export const reportScheduleRunStateSchema = z.enum(REPORT_SCHEDULE_RUN_STATES);

/** Delivery failure classification (spec 012, US3 — gated on 009 = READY). */
export const REPORT_SCHEDULE_FAILURE_CLASSES = [
  "generation",
  "transient_send",
  "permanent_send",
  "missing_configuration",
] as const;
export type ReportScheduleFailureClass =
  (typeof REPORT_SCHEDULE_FAILURE_CLASSES)[number];
export const reportScheduleFailureClassSchema = z.enum(
  REPORT_SCHEDULE_FAILURE_CLASSES,
);

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
  executive: ["search_visibility", "traffic", "opportunities", "insights"],
};

export function sectionsForReportType(type: ReportType): ReportSectionKey[] {
  return REPORT_TYPE_SECTIONS[type];
}

// Presentation labels shared by the server renderers (PDF/print HTML) and
// the client. Single-sourced so the three surfaces cannot drift apart.
export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  overview: "Overview",
  search_performance: "Search performance",
  rank_tracking: "Rank tracking",
  technical: "Technical",
  executive: "Executive",
};

export const REPORT_SECTION_TITLES: Record<ReportSectionKey, string> = {
  search_visibility: "Search visibility",
  traffic: "Traffic",
  conversions: "Conversions",
  rankings: "Rankings",
  technical: "Technical health",
  backlinks: "Backlinks",
  opportunities: "Opportunities",
  insights: "Insights",
};

export function unavailableSectionNote(reason: string | null): string | null {
  switch (reason) {
    case "not_connected":
      return "Not connected — connect this source to include its data.";
    case "no_coverage":
      return "No coverage for this period.";
    case "provider_failed":
      return "Collection failed — this section is unavailable.";
    case "no_data":
      return "No data yet.";
    default:
      return null;
  }
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
 * Frozen agency+client combination (final-plan §12). Stored in the separate
 * `branding_snapshot_json` column — the payload version stays untouched.
 * Profile notes are internal-only and never enter the snapshot.
 */
export const brandingSnapshotSchema = z.object({
  agency: z
    .object({
      name: z.string(),
      logoR2Key: z.string().nullable(),
      accentColor: z.string().nullable(),
      footerText: z.string().nullable(),
    })
    .nullable(),
  client: z
    .object({
      name: z.string(),
      logoR2Key: z.string().nullable(),
      titleOverride: z.string().nullable(),
    })
    .nullable(),
});
export type BrandingSnapshot = z.infer<typeof brandingSnapshotSchema>;

export function parseBrandingSnapshot(
  json: string | null,
): BrandingSnapshot | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = brandingSnapshotSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

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
