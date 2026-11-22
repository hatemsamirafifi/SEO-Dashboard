/**
 * SAM SEO Analyst Phase 1 contracts (shared client/server).
 *
 * Two layers, kept strictly separate:
 * - `SeoEvidenceObservation` rows are MEASURED FACTS pulled from data-source
 *   tools (rank tracking, Search Console, audits, backlinks, …). They are
 *   recorded as-observed and never rewritten by the model.
 * - `SeoRecommendation` rows are MODEL INTERPRETATIONS over those facts. Every
 *   recommendation must carry at least one `SeoEvidenceReference` pointing
 *   back to a measured observation (source tool, provider, metric, value,
 *   record id) so any claim is traceable to data actually seen.
 *
 * `SeoAnalysisResult` is the frozen Phase 1 output envelope: source
 * availability, measured overview (per source, optional when unavailable),
 * capability flags, recommendations, and explicit gaps/limitations.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Source availability
// ---------------------------------------------------------------------------

export const SeoSourceKeySchema = z.enum([
  "rank_tracking",
  "search_console",
  "saved_keywords",
  "site_audit",
  "backlinks",
  "domain_overview",
  "competitors",
]);

export type SeoSourceKey = z.infer<typeof SeoSourceKeySchema>;

export const SeoSourceHealthSchema = z.enum([
  "available",
  "partial",
  "unavailable",
  "stale",
  "failed",
]);

export type SeoSourceHealth = z.infer<typeof SeoSourceHealthSchema>;

/** Per-source availability card shown to the user before any analysis. */
export const SeoSourceStatusSchema = z.object({
  source: SeoSourceKeySchema,
  status: SeoSourceHealthSchema,
  provider: z.string().nullable().optional(),
  observationDateRange: z
    .object({ from: z.string().nullable(), to: z.string().nullable() })
    .optional(),
  freshnessLabel: z.string(),
  ageDays: z.number().nullable().optional(),
  recordCount: z.number().int().nonnegative(),
  limitations: z.array(z.string()).default([]),
});

export type SeoSourceStatus = z.infer<typeof SeoSourceStatusSchema>;

// ---------------------------------------------------------------------------
// Measured evidence (facts, not interpretation)
// ---------------------------------------------------------------------------

/**
 * One measured data point from a data-source tool. `isMeasured` is locked to
 * `true` for this schema on purpose: model interpretations live on
 * `SeoRecommendation`, never here.
 */
export const SeoEvidenceObservationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Data-source tool that produced the row, e.g. "get_rank_tracker". */
  sourceTool: z.string(),
  provider: z.string(),
  metricName: z.string(),
  metricValue: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  observationDate: z.string().nullable(),
  dateRange: z
    .object({ from: z.string().nullable(), to: z.string().nullable() })
    .nullable()
    .optional(),
  device: z.enum(["desktop", "mobile", "all"]).nullable().optional(),
  countryOrLocation: z.string().nullable().optional(),
  urlOrKeyword: z.string().nullable().optional(),
  dataFreshness: z.string(),
  sourceRecordIds: z.array(z.string()).default([]),
  qualityOrLimitations: z.string().nullable().optional(),
  isMeasured: z.literal(true).default(true),
});

export type SeoEvidenceObservation = z.infer<
  typeof SeoEvidenceObservationSchema
>;

// ---------------------------------------------------------------------------
// Opportunity thresholds
// ---------------------------------------------------------------------------

export const KeywordOpportunityThresholdsSchema = z.object({
  strikingMinPos: z.number().default(4),
  strikingMaxPos: z.number().default(20),
  minImpressionsForCtr: z.number().default(100),
  /** CTR considered low at or below this ratio (default 2%). */
  lowCtrThreshold: z.number().default(0.02),
  minPositionDrop: z.number().default(3),
  minImpressionsForTrend: z.number().default(50),
});

export type KeywordOpportunityThresholds = z.infer<
  typeof KeywordOpportunityThresholdsSchema
>;

/** Single shared default so every consumer starts from the same priors. */
export const DEFAULT_OPPORTUNITY_THRESHOLDS: KeywordOpportunityThresholds =
  KeywordOpportunityThresholdsSchema.parse({});

// ---------------------------------------------------------------------------
// Recommendations (model interpretation over measured evidence)
// ---------------------------------------------------------------------------

/** Pointer back to a measured observation a recommendation relies on. */
export const SeoEvidenceReferenceSchema = z.object({
  sourceTool: z.string(),
  provider: z.string(),
  observationDate: z.string().nullable(),
  metricName: z.string(),
  metricValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  urlOrKeyword: z.string().nullable().optional(),
  sourceRecordId: z.string().nullable().optional(),
});

export type SeoEvidenceReference = z.infer<typeof SeoEvidenceReferenceSchema>;

export const RecommendationCategorySchema = z.enum([
  "performance_overview",
  "keyword_opportunity",
  "ranking_drop",
  "content_technical",
  "competitor_opportunity",
]);

export type RecommendationCategory = z.infer<
  typeof RecommendationCategorySchema
>;

export const RecommendationPrioritySchema = z.enum([
  "Critical",
  "High",
  "Medium",
  "Low",
]);

export type RecommendationPriority = z.infer<
  typeof RecommendationPrioritySchema
>;

export const RecommendationImpactSchema = z.enum([
  "High",
  "Medium",
  "Low",
  "Unknown",
]);

export type RecommendationImpact = z.infer<typeof RecommendationImpactSchema>;

export const RecommendationEffortSchema = z.enum([
  "High",
  "Medium",
  "Low",
  "Unknown",
]);

export type RecommendationEffort = z.infer<typeof RecommendationEffortSchema>;

export const RecommendationConfidenceSchema = z.object({
  level: z.enum(["High", "Medium", "Low"]),
  score: z.number().min(0).max(100),
  rationale: z.string(),
});

export type RecommendationConfidence = z.infer<
  typeof RecommendationConfidenceSchema
>;

// ---------------------------------------------------------------------------
// Phase 2: Evidence Quality Gates & Signal Strength
// ---------------------------------------------------------------------------

export const SeoEvidenceSignalStrengthSchema = z.enum([
  "confirmed_defect",
  "strong_signal",
  "suspicious_investigate",
  "insufficient_evidence",
]);

export type SeoEvidenceSignalStrength = z.infer<
  typeof SeoEvidenceSignalStrengthSchema
>;

export const SeoSampleSizeSchema = z.enum([
  "sparse",
  "moderate",
  "robust",
]);

export type SeoSampleSize = z.infer<typeof SeoSampleSizeSchema>;

export const SeoEvidenceQualitySchema = z.object({
  signalStrength: SeoEvidenceSignalStrengthSchema,
  sampleSize: SeoSampleSizeSchema,
  dataFreshnessDays: z.number().nullable().optional(),
  comparabilityNotes: z.string().nullable().optional(),
  isDestructiveActionRecommended: z.boolean().default(false),
});

export type SeoEvidenceQuality = z.infer<typeof SeoEvidenceQualitySchema>;

// ---------------------------------------------------------------------------
// Phase 2: Persistent Action Tracking Contracts
// ---------------------------------------------------------------------------

export const SeoActionStatusSchema = z.enum([
  "proposed",
  "accepted",
  "in_progress",
  "completed",
  "verification_pending",
  "verified",
  "dismissed",
  "blocked",
  "reopened",
]);

export type SeoActionStatus = z.infer<typeof SeoActionStatusSchema>;

export const SeoVerificationOutcomeSchema = z.enum([
  "implemented_improved",
  "implemented_unchanged",
  "implemented_declined",
  "insufficient_data",
]);

export type SeoVerificationOutcome = z.infer<
  typeof SeoVerificationOutcomeSchema
>;

export const SeoActionPlanSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.string().default("active"),
  createdBy: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SeoActionPlan = z.infer<typeof SeoActionPlanSchema>;

export const SeoActionItemSchema = z.object({
  id: z.string(),
  actionPlanId: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  recommendationFingerprint: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  category: RecommendationCategorySchema,
  priority: RecommendationPrioritySchema,
  effort: RecommendationEffortSchema.optional(),
  expectedImpact: RecommendationImpactSchema.optional(),
  evidenceConfidence: z.string().nullable().optional(),
  targetKeyword: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
  recommendedAction: z.string(),
  validationMetric: z.string(),
  baselineValue: z.string().nullable().optional(),
  baselineObservationDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  status: SeoActionStatusSchema.default("proposed"),
  verificationOutcome: SeoVerificationOutcomeSchema.nullable().optional(),
  verificationNotes: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
});

export type SeoActionItem = z.infer<typeof SeoActionItemSchema>;

export const SeoActionEvidenceSchema = z.object({
  id: z.string(),
  actionItemId: z.string(),
  source: z.string(),
  provider: z.string(),
  sourceRecordId: z.string().nullable().optional(),
  metricName: z.string(),
  metricValue: z.string(),
  observationDate: z.string().nullable().optional(),
  observationRange: z.string().nullable().optional(),
  targetDevice: z.string().nullable().optional(),
  targetCountry: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type SeoActionEvidence = z.infer<typeof SeoActionEvidenceSchema>;

export const SeoActionEventSchema = z.object({
  id: z.string(),
  actionItemId: z.string(),
  actor: z.string(),
  previousStatus: z.string().nullable().optional(),
  newStatus: z.string(),
  notes: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.string(),
});

export type SeoActionEvent = z.infer<typeof SeoActionEventSchema>;

export const ExistingActionItemSummarySchema = z.object({
  id: z.string(),
  status: SeoActionStatusSchema,
  actionPlanId: z.string(),
  baselineMeasurement: z.string().nullable().optional(),
  verificationOutcome: SeoVerificationOutcomeSchema.nullable().optional(),
});

export type ExistingActionItemSummary = z.infer<
  typeof ExistingActionItemSummarySchema
>;

export const SeoRecommendationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  fingerprint: z.string().default(""),
  category: RecommendationCategorySchema,
  title: z.string(),
  explanation: z.string(),
  /** At least one measured-evidence pointer — no evidence, no recommendation. */
  evidenceReferences: z.array(SeoEvidenceReferenceSchema).min(1),
  targetKeywords: z.array(z.string()).default([]),
  targetUrls: z.array(z.string()).default([]),
  priority: RecommendationPrioritySchema,
  expectedImpact: RecommendationImpactSchema,
  implementationEffort: RecommendationEffortSchema,
  confidence: RecommendationConfidenceSchema,
  evidenceQuality: SeoEvidenceQualitySchema.optional(),
  existingActionItem: ExistingActionItemSummarySchema.nullable().optional(),
  recommendedAction: z.string(),
  reason: z.string(),
  validationMetric: z.string(),
  baselineMeasurement: z.string().nullable().optional(),
  reviewPeriod: z.string(),
  /** Phase 1 only proposes; execution states arrive in later phases. */
  status: z.literal("Proposed").default("Proposed"),
});

export type SeoRecommendation = z.infer<typeof SeoRecommendationSchema>;

// ---------------------------------------------------------------------------
// Analysis result envelope
// ---------------------------------------------------------------------------

export const SeoAnalysisFocusSchema = z.enum([
  "full",
  "performance",
  "keywords",
  "ranking_drops",
  "content_technical",
  "competitors",
  "action_plan",
]);

export type SeoAnalysisFocus = z.infer<typeof SeoAnalysisFocusSchema>;

const GscTotalsSchema = z.object({
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});

/**
 * Phase 1 analysis output. `measuredOverview` sections are `.optional()` —
 * a missing section means that source was unavailable, which is also
 * declared in `sourceAvailability`. `capabilities` are free-form flags per
 * analysis area (e.g. why a section produced no findings).
 */
export const SeoAnalysisResultSchema = z.object({
  projectId: z.string(),
  domain: z.string().nullable(),
  analyzedAt: z.string(),
  focus: SeoAnalysisFocusSchema,
  thresholds: KeywordOpportunityThresholdsSchema,
  sourceAvailability: z.array(SeoSourceStatusSchema),
  measuredOverview: z.object({
    rankTracking: z
      .object({
        configured: z.boolean(),
        trackedKeywordsCount: z.number(),
        activeTargetsCount: z.number(),
        latestRunDate: z.string().nullable(),
        averagePosition: z.number().nullable(),
        top10Count: z.number(),
        top3Count: z.number(),
        improvedCount: z.number(),
        declinedCount: z.number(),
      })
      .optional(),
    searchConsole: z
      .object({
        connected: z.boolean(),
        coverageRange: z.object({
          from: z.string().nullable(),
          to: z.string().nullable(),
        }),
        totals: GscTotalsSchema.nullable(),
        previousTotals: GscTotalsSchema.nullable().optional(),
      })
      .optional(),
    siteAudit: z
      .object({
        hasAudit: z.boolean(),
        auditId: z.string().nullable(),
        status: z.string().nullable(),
        completedAt: z.string().nullable(),
        pagesCrawled: z.number(),
        criticalIssuesCount: z.number(),
        warningIssuesCount: z.number(),
        infoIssuesCount: z.number(),
      })
      .optional(),
    backlinks: z
      .object({
        hasSnapshot: z.boolean(),
        capturedAt: z.string().nullable(),
        backlinks: z.number().nullable(),
        referringDomains: z.number().nullable(),
        rank: z.number().nullable(),
      })
      .optional(),
    savedKeywordsCount: z.number().default(0),
  }),
  capabilities: z.object({
    performanceOverview: z.record(z.string(), z.unknown()),
    keywordOpportunities: z.record(z.string(), z.unknown()),
    rankingDrops: z.record(z.string(), z.unknown()),
    contentTechnical: z.record(z.string(), z.unknown()),
    competitorOpportunities: z.record(z.string(), z.unknown()),
  }),
  recommendations: z.array(SeoRecommendationSchema),
  missingInformation: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  markdownFallback: z.string(),
});

export type SeoAnalysisResult = z.infer<typeof SeoAnalysisResultSchema>;
