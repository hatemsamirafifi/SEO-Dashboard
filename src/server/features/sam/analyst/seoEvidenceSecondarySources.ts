/**
 * Secondary evidence collectors (Saved Keywords & Competitor Snapshots) for SAM SEO Analyst.
 * Extracted to maintain file size constraints (<400 lines).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { competitorSnapshots } from "@/db/schema";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import type {
  SeoEvidenceObservation,
  SeoSourceStatus,
} from "@/shared/samSeoAnalyst";

// ---------------------------------------------------------------------------
// 5. Saved Keywords Collector
// ---------------------------------------------------------------------------
export async function collectSavedKeywords(projectId: string) {
  const saved = await KeywordResearchRepository.listSavedKeywordsByProject({
    projectId,
    page: 1,
    pageSize: 100,
  });

  const observations: SeoEvidenceObservation[] = saved.rows
    .slice(0, 50)
    .map(({ row, metric }) => ({
      id: `sk:${row.id}`,
      projectId,
      sourceTool: "list_saved_keywords",
      provider: "local_cache",
      metricName: "saved_keyword",
      metricValue: metric?.searchVolume ?? null,
      observationDate: row.createdAt,
      urlOrKeyword: row.keyword,
      dataFreshness: "stored",
      sourceRecordIds: [row.id],
      qualityOrLimitations: `Difficulty: ${metric?.keywordDifficulty ?? "unknown"}, CPC: ${metric?.cpc ?? "unknown"}`,
      isMeasured: true as const,
    }));

  const savedStatus: SeoSourceStatus["status"] =
    saved.totalCount > 0 ? "available" : "unavailable";

  return {
    status: {
      source: "saved_keywords" as const,
      status: savedStatus,
      freshnessLabel: `${saved.totalCount} saved keywords`,
      recordCount: saved.totalCount,
      limitations:
        saved.totalCount === 0
          ? ["No saved keywords found for this project."]
          : [],
    },
    count: saved.totalCount,
    rows: saved.rows,
    observations,
  };
}

// ---------------------------------------------------------------------------
// 6. Competitors Collector
// ---------------------------------------------------------------------------
export async function collectCompetitors(projectId: string) {
  const rows = await db
    .select()
    .from(competitorSnapshots)
    .where(eq(competitorSnapshots.projectId, projectId))
    .orderBy(desc(competitorSnapshots.id))
    .limit(10);

  const compStatus: SeoSourceStatus["status"] =
    rows.length > 0 ? "available" : "unavailable";

  return {
    status: {
      source: "competitors" as const,
      status: compStatus,
      freshnessLabel:
        rows.length > 0
          ? `${rows.length} competitor snapshots`
          : "None configured",
      recordCount: rows.length,
      limitations:
        rows.length === 0
          ? ["No competitor snapshots stored for this project."]
          : [],
    },
    rows,
  };
}
