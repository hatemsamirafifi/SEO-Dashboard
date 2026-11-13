import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { rankTrackingConfigs } from "@/db/schema";
import { MAX_TRACKED_KEYWORD_LENGTH } from "@/shared/rank-tracking";
import type {
  MissingRankingBucket,
  MissingRankingsBreakdown,
} from "@/shared/rank-tracking";
import { domainField } from "@/types/schemas/domain";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type RankTrackingConfig = InferSelectModel<typeof rankTrackingConfigs>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

export type RankCheckTriggerResult =
  | {
      ok: true;
      runId: string;
      operationId?: string;
      scope?: "selected" | "all";
      selectedCount?: number;
      validatedCount?: number;
      validatedKeywordIds?: string[];
      unselectedCount?: number;
      breakdown?: MissingRankingsBreakdown;
      candidatesCount?: number;
      missingEligibleBeforeFilter?: number;
      selectedStates?: MissingRankingBucket[];
    }
  | {
      ok: false;
      reason: "already_running" | "no_missing_rankings";
      blockingRunId?: string | null;
      operationId?: string;
      /** Missing-rankings mode: 0 keywords were eligible — NO run created. */
      eligibleCount?: number;
      breakdown?: MissingRankingsBreakdown;
      candidatesCount?: number;
      missingEligibleBeforeFilter?: number;
      selectedStates?: MissingRankingBucket[];
    };

export interface RankTrackingDeviceResult {
  position: number | null;
  previousPosition: number | null;
  rankingUrl: string | null;
  serpFeatures: string[];
  checkedAt?: string | null;
  status?: "not_checked" | "ranked" | "not_ranking" | "failed" | "checking";
  rankingStatus?:
    | "RANKED"
    | "NO_RESULT"
    | "CHECK_FAILED"
    | "NOT_CHECKED"
    | null;
  latestValidPosition?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerStatus?: string | null;
  providerStatusCode?: number | null;
  provider?: string | null;
}

export interface RankTrackingRow {
  trackingKeywordId: string;
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  desktop: RankTrackingDeviceResult;
  mobile: RankTrackingDeviceResult;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const devicesEnum = z.enum(rankTrackingConfigs.devices.enumValues);
const scheduleEnum = z.enum(rankTrackingConfigs.scheduleInterval.enumValues);
export const getConfigsSchema = z.object({
  projectId: z.string().uuid(),
});

export const createConfigSchema = z.object({
  projectId: z.string().uuid(),
  domain: domainField,
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().max(10).optional(),
  locationName: z.string().min(1).max(200).optional(),
  devices: devicesEnum.optional(),
  serpDepth: z.number().int().min(10).max(100).multipleOf(10),
  scheduleInterval: scheduleEnum.optional(),
});

export const updateConfigSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  domain: domainField.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().max(10).optional(),
  locationName: z.string().min(1).max(200).nullable().optional(),
  devices: devicesEnum.optional(),
  serpDepth: z.number().int().min(10).max(100).multipleOf(10).optional(),
  scheduleInterval: scheduleEnum.optional(),
  isActive: z.boolean().optional(),
});

export const missingRankingBucketSchema = z.enum([
  "ranking_unavailable",
  "lost",
  "no_ranking",
]);

export const triggerCheckSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).max(2000).optional(),
  /** "Check missing rankings" mode: resolve eligible ids server-side. */
  missingRankings: z.boolean().optional(),
  /** Optional filter to restrict check to specific missing ranking states. */
  missingRankingStates: z.array(missingRankingBucketSchema).optional(),
  operationId: z.string().optional(),
});

export const missingRankingsSummarySchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).max(2000).optional(),
});

export const cancelRankCheckSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid().optional(),
  runId: z.string().uuid(),
});

export const comparePeriodSchema = z.enum(["1d", "7d", "30d", "90d"]);
export type ComparePeriod = z.infer<typeof comparePeriodSchema>;

export const getLatestResultsSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  comparePeriod: comparePeriodSchema.optional(),
  trackingTargetId: z.string().uuid().optional(),
});

export const getLatestRunSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
});

export const estimateCostSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
});

export const addKeywordsSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  keywords: z
    .array(z.string().min(1).max(MAX_TRACKED_KEYWORD_LENGTH))
    .min(1)
    .max(2000),
});

export const removeKeywordsSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).min(1).max(2000),
});

export const refreshMetricsSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
});

const deviceEnum = z.enum(["desktop", "mobile"]);
const sinceDaysField = z.number().int().positive().max(730).default(365);

export const getSerpClustersSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  device: deviceEnum,
});

export const getKeywordHistorySchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  trackingKeywordId: z.string().uuid(),
  sinceDays: sinceDaysField,
  trackingTargetId: z.string().uuid().optional(),
});

export const getConfigTrendSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  device: deviceEnum,
  sinceDays: sinceDaysField,
  trackingTargetId: z.string().uuid().optional(),
});

export const getPositionMatrixSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  device: deviceEnum,
  runLimit: z.number().int().positive().max(26).default(12),
  trackingTargetId: z.string().uuid().optional(),
});

export interface RankTrackingTarget {
  id: string;
  organizationId: string;
  localProjectId: string;
  trackingConfigId?: string | null;
  searchEngine: string;
  countryCode: string;
  regionCode?: string | null;
  cityName?: string | null;
  languageCode: string;
  device: "desktop" | "mobile";
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const createTargetSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid().optional(),
  countryCode: z.string().min(2).max(10),
  regionCode: z.string().optional(),
  cityName: z.string().optional(),
  languageCode: z.string().min(2).max(10).default("en"),
  device: z.enum(["desktop", "mobile"]),
});

export const removeTargetSchema = z.object({
  projectId: z.string().uuid(),
  targetId: z.string().uuid(),
});

export const syncSeRankingSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  domain: z.string().min(1),
});

export const migrateAccountSchema = z.object({
  organizationId: z.string().uuid(),
  newApiKey: z.string().min(1),
});

export const toggleTargetSchema = z.object({
  projectId: z.string().uuid(),
  targetId: z.string().uuid(),
  enabled: z.boolean(),
});

export const setKeywordTargetAssignmentsSchema = z.object({
  projectId: z.string().uuid(),
  targetId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).min(1).max(2000),
  enabled: z.boolean(),
});

export const seRankingSyncStatusInputSchema = z.object({
  projectId: z.string().uuid().optional(),
});

export const retrySeRankingSyncSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid().optional(),
});

export const triggerOrgAccountMigrationSchema = z.object({
  newApiKey: z.string().min(1).optional(),
  projectId: z.string().uuid().optional(),
});
