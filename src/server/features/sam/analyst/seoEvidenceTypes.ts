import type { competitorSnapshots } from "@/db/schema";
import type { FlattenedRankObservationRow } from "@/server/mcp/tools/get-rank-tracker-format";
import type { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import type { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import type { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import type {
  KeywordOpportunityThresholds,
  SeoAnalysisFocus,
  SeoEvidenceObservation,
  SeoSourceStatus,
} from "@/shared/samSeoAnalyst";

export interface CollectSeoEvidenceInput {
  projectId: string;
  organizationId: string;
  focus?: SeoAnalysisFocus;
  thresholds?: Partial<KeywordOpportunityThresholds>;
}

export interface CollectedSeoEvidence {
  projectId: string;
  domain: string | null;
  collectedAt: string;
  focus: SeoAnalysisFocus;
  thresholds: KeywordOpportunityThresholds;
  sourceAvailability: SeoSourceStatus[];
  observations: SeoEvidenceObservation[];
  measuredOverview: {
    rankTracking?: {
      configured: boolean;
      trackedKeywordsCount: number;
      activeTargetsCount: number;
      latestRunDate: string | null;
      averagePosition: number | null;
      top10Count: number;
      top3Count: number;
      improvedCount: number;
      declinedCount: number;
    };
    searchConsole?: {
      connected: boolean;
      coverageRange: { from: string | null; to: string | null };
      totals: {
        clicks: number;
        impressions: number;
        ctr: number;
        position: number;
      } | null;
      previousTotals?: {
        clicks: number;
        impressions: number;
        ctr: number;
        position: number;
      } | null;
    };
    siteAudit?: {
      hasAudit: boolean;
      auditId: string | null;
      status: string | null;
      completedAt: string | null;
      pagesCrawled: number;
      criticalIssuesCount: number;
      warningIssuesCount: number;
      infoIssuesCount: number;
    };
    backlinks?: {
      hasSnapshot: boolean;
      capturedAt: string | null;
      backlinks: number | null;
      referringDomains: number | null;
      rank: number | null;
    };
    savedKeywordsCount: number;
  };
  details: {
    rankTrackingRows: FlattenedRankObservationRow[];
    gscStrikingQueries: Awaited<
      ReturnType<typeof GscSearchPerformanceRepository.getStrikingDistance>
    >;
    gscTopQueries: Array<{
      key: string;
      clicks: number;
      impressions: number;
      position: number;
    }>;
    gscTopPages: Array<{
      key: string;
      clicks: number;
      impressions: number;
      position: number;
    }>;
    auditIssues: Awaited<ReturnType<typeof AuditRepository.getIssuesForAudit>>;
    auditPages: Awaited<ReturnType<typeof AuditRepository.getPagesForAudit>>;
    savedKeywords: Awaited<
      ReturnType<typeof KeywordResearchRepository.listSavedKeywordsByProject>
    >["rows"];
    competitorSnapshots: Array<typeof competitorSnapshots.$inferSelect>;
  };
  limitations: string[];
  missingInformation: string[];
}
