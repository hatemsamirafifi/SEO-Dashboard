/**
 * SAM SEO Analyst Phase 1 - Unified SEO Evidence Collector Pipeline.
 *
 * Coordinates concurrent, read-only collection of project SEO evidence
 * across local database tables and repositories.
 */
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import {
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  type KeywordOpportunityThresholds,
  type SeoEvidenceObservation,
  type SeoSourceStatus,
} from "@/shared/samSeoAnalyst";
import type {
  CollectSeoEvidenceInput,
  CollectedSeoEvidence,
} from "./seoEvidenceTypes";
import {
  collectBacklinks,
  collectCompetitors,
  collectRankTracking,
  collectSavedKeywords,
  collectSearchConsole,
  collectSiteAudit,
} from "./seoEvidenceSources";

export type {
  CollectSeoEvidenceInput,
  CollectedSeoEvidence,
} from "./seoEvidenceTypes";

const SOURCE_TIMEOUT_MS = 6000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SourceSettled<T> = PromiseSettledResult<T | null>;

function processRankTrackingResult(
  res: SourceSettled<Awaited<ReturnType<typeof collectRankTracking>>>,
  sourceStatuses: SeoSourceStatus[],
  observations: SeoEvidenceObservation[],
  missingInformation: string[],
  limitations: string[],
) {
  const data = res.status === "fulfilled" ? res.value : null;
  if (!data) {
    sourceStatuses.push({
      source: "rank_tracking",
      status: "failed",
      freshnessLabel: "Timeout or query error",
      recordCount: 0,
      limitations: ["Rank tracking query timed out or encountered an error."],
    });
    limitations.push("Rank tracking data could not be retrieved.");
    return null;
  }
  sourceStatuses.push(data.status);
  observations.push(...data.observations);
  if (data.status.status === "unavailable") {
    missingInformation.push(
      "Rank tracking is not configured for this project.",
    );
  }
  return data;
}

function processGscResult(
  res: SourceSettled<Awaited<ReturnType<typeof collectSearchConsole>>>,
  sourceStatuses: SeoSourceStatus[],
  observations: SeoEvidenceObservation[],
  missingInformation: string[],
  limitations: string[],
) {
  const data = res.status === "fulfilled" ? res.value : null;
  if (!data) {
    sourceStatuses.push({
      source: "search_console",
      status: "failed",
      freshnessLabel: "Timeout or query error",
      recordCount: 0,
      limitations: ["Google Search Console query timed out or failed."],
    });
    limitations.push("Search Console data could not be retrieved.");
    return null;
  }
  sourceStatuses.push(data.status);
  observations.push(...data.observations);
  if (data.status.status === "unavailable") {
    missingInformation.push("Google Search Console is not connected.");
  }
  return data;
}

function processSiteAuditResult(
  res: SourceSettled<Awaited<ReturnType<typeof collectSiteAudit>>>,
  sourceStatuses: SeoSourceStatus[],
  observations: SeoEvidenceObservation[],
  missingInformation: string[],
) {
  const data = res.status === "fulfilled" ? res.value : null;
  if (!data) {
    sourceStatuses.push({
      source: "site_audit",
      status: "failed",
      freshnessLabel: "Timeout or query error",
      recordCount: 0,
      limitations: ["Site audit query timed out or failed."],
    });
    return null;
  }
  sourceStatuses.push(data.status);
  observations.push(...data.observations);
  if (data.status.status === "unavailable") {
    missingInformation.push(
      "No site audit has been executed for this project.",
    );
  }
  return data;
}

function processBacklinksResult(
  res: SourceSettled<Awaited<ReturnType<typeof collectBacklinks>>>,
  sourceStatuses: SeoSourceStatus[],
  observations: SeoEvidenceObservation[],
  missingInformation: string[],
) {
  const data = res.status === "fulfilled" ? res.value : null;
  if (!data) {
    sourceStatuses.push({
      source: "backlinks",
      status: "unavailable",
      freshnessLabel: "Unavailable",
      recordCount: 0,
      limitations: ["Backlinks data could not be retrieved."],
    });
    return null;
  }
  sourceStatuses.push(data.status);
  observations.push(...data.observations);
  if (data.status.status === "unavailable") {
    missingInformation.push("Backlink data is not available.");
  }
  return data;
}

export async function collectProjectSeoEvidence(
  input: CollectSeoEvidenceInput,
): Promise<CollectedSeoEvidence> {
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    input.organizationId,
  );

  if (!project) {
    throw new AppError("NOT_FOUND", "Project not found or unauthorized");
  }

  const focus = input.focus ?? "full";
  const thresholds: KeywordOpportunityThresholds = {
    ...DEFAULT_OPPORTUNITY_THRESHOLDS,
    ...input.thresholds,
  };

  const limitations: string[] = [];
  const missingInformation: string[] = [];

  const [
    rankTrackingRes,
    searchConsoleRes,
    siteAuditRes,
    backlinksRes,
    savedKeywordsRes,
    competitorsRes,
  ] = await Promise.allSettled([
    withTimeout(collectRankTracking(input.projectId), SOURCE_TIMEOUT_MS, null),
    withTimeout(collectSearchConsole(input.projectId), SOURCE_TIMEOUT_MS, null),
    withTimeout(collectSiteAudit(input.projectId), SOURCE_TIMEOUT_MS, null),
    withTimeout(collectBacklinks(input.projectId), SOURCE_TIMEOUT_MS, null),
    withTimeout(collectSavedKeywords(input.projectId), SOURCE_TIMEOUT_MS, null),
    withTimeout(collectCompetitors(input.projectId), SOURCE_TIMEOUT_MS, null),
  ]);

  const sourceStatuses: SeoSourceStatus[] = [];
  const observations: SeoEvidenceObservation[] = [];

  const rtData = processRankTrackingResult(
    rankTrackingRes,
    sourceStatuses,
    observations,
    missingInformation,
    limitations,
  );
  const gscData = processGscResult(
    searchConsoleRes,
    sourceStatuses,
    observations,
    missingInformation,
    limitations,
  );
  const auditData = processSiteAuditResult(
    siteAuditRes,
    sourceStatuses,
    observations,
    missingInformation,
  );
  const blData = processBacklinksResult(
    backlinksRes,
    sourceStatuses,
    observations,
    missingInformation,
  );

  const skData =
    savedKeywordsRes.status === "fulfilled" ? savedKeywordsRes.value : null;
  if (skData) {
    sourceStatuses.push(skData.status);
    observations.push(...skData.observations);
  }

  const compData =
    competitorsRes.status === "fulfilled" ? competitorsRes.value : null;
  if (compData) {
    sourceStatuses.push(compData.status);
    if (compData.status.status === "unavailable") {
      missingInformation.push("No competitor analysis configured.");
    }
  }

  return {
    projectId: input.projectId,
    domain: project.domain,
    collectedAt: new Date().toISOString(),
    focus,
    thresholds,
    sourceAvailability: sourceStatuses,
    observations,
    measuredOverview: {
      rankTracking: rtData?.overview,
      searchConsole: gscData?.overview,
      siteAudit: auditData?.overview,
      backlinks: blData?.overview,
      savedKeywordsCount: skData?.count ?? 0,
    },
    details: {
      rankTrackingRows: rtData?.flattened ?? [],
      gscStrikingQueries: gscData?.striking ?? [],
      gscTopQueries: gscData?.topQueries ?? [],
      gscTopPages: gscData?.topPages ?? [],
      auditIssues: auditData?.issues ?? [],
      auditPages: auditData?.pages ?? [],
      savedKeywords: skData?.rows ?? [],
      competitorSnapshots: compData?.rows ?? [],
    },
    limitations,
    missingInformation,
  };
}
