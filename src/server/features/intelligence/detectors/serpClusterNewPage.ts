import { canonicalSerpClusterKey } from "@/shared/intelligence";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { SerpClusteringService } from "@/server/features/serp/clustering/SerpClusteringService";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";

/**
 * `serp_cluster_new_page` (spec 019): pages that keep appearing together on
 * the tracked keywords, where at least one of them is a page the project does
 * not own yet.
 *
 * The detector reports the observed co-occurrence; it never states that a
 * cluster produces a ranking outcome, and it never calls a provider.
 */

/** Configs read per scan - the clustering read is bounded per config. */
const MAX_CONFIGS = 5;

export type SerpClusterCandidate = {
  configId: string;
  clusterId: string;
  keywordCount: number;
  pageCount: number;
  newPageUrls: string[];
  keywords: string[];
  coverageStatus: string;
  coveragePercent: number;
  locationCode: number;
  languageCode: string;
  device: "desktop" | "mobile";
};

export type SerpClusterNewPageInput = {
  candidates: SerpClusterCandidate[];
  thresholds: Record<string, string | number | boolean>;
};

export function isSerpClusterNewPageInput(
  value: unknown,
): value is SerpClusterNewPageInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "candidates" in value &&
    Array.isArray(value.candidates) &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export async function fetchSerpClusterNewPageInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<SerpClusterNewPageInput> {
  const threshold = thresholdNumber(ctx.thresholds, "minKeywordThreshold");
  const minCoverageRatio = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const freshnessDays = thresholdNumber(ctx.thresholds, "freshnessDays");
  const minClusterPages = thresholdNumber(ctx.thresholds, "minClusterPages");
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) {
    throw new InsufficientCoverageError(
      "serp_cluster_new_page: no rank-tracking config for this project",
    );
  }
  const candidates: SerpClusterCandidate[] = [];
  for (const config of configs.slice(0, MAX_CONFIGS)) {
    const devices: Array<"desktop" | "mobile"> =
      config.devices === "both" ? ["desktop", "mobile"] : [config.devices];
    for (const device of devices) {
      const report = await SerpClusteringService.getClusters({
        projectId,
        configId: config.id,
        device,
        threshold,
        freshnessDays,
        minCoverageRatio,
      });
      for (const cluster of report.clusters) {
        if (cluster.pages.length < minClusterPages) continue;
        if (cluster.newPageUrls.length === 0) continue;
        candidates.push({
          configId: config.id,
          clusterId: cluster.id,
          keywordCount: cluster.keywordCount,
          pageCount: cluster.pages.length,
          newPageUrls: cluster.newPageUrls,
          keywords: cluster.keywords,
          coverageStatus: report.coverage.status,
          coveragePercent: report.coverage.percent,
          locationCode: report.market.locationCode,
          languageCode: report.market.languageCode,
          device: report.device,
        });
      }
    }
  }
  return {
    candidates,
    thresholds: {
      minKeywordThreshold: threshold,
      minCoverageRatio,
      freshnessDays,
      minClusterPages,
    },
  };
}

export function detectSerpClusterNewPage(
  ctx: DetectorContext,
  input: SerpClusterNewPageInput,
): FindingDraft[] {
  const minKeywordThreshold = thresholdNumber(
    ctx.thresholds,
    "minKeywordThreshold",
  );
  const findings: FindingDraft[] = [];
  for (const candidate of input.candidates) {
    if (candidate.keywordCount < minKeywordThreshold) continue;
    const entityKey = canonicalSerpClusterKey(
      candidate.configId,
      candidate.clusterId,
    );
    findings.push({
      entityKey,
      entity: {
        configId: candidate.configId,
        clusterId: candidate.clusterId,
        keywordCount: candidate.keywordCount,
        pageCount: candidate.pageCount,
        newPageUrls: candidate.newPageUrls.join(", "),
        keywords: candidate.keywords.join(", "),
        device: candidate.device,
        locationCode: candidate.locationCode,
        languageCode: candidate.languageCode,
      },
      explanationFact:
        `${candidate.pageCount} pages were observed together on ` +
        `${candidate.keywordCount} tracked keywords for ${candidate.device} ` +
        `in location ${candidate.locationCode}; ` +
        `${candidate.newPageUrls.length} of them are not pages of this project.`,
      evidence: {
        metrics: {
          keywordCount: candidate.keywordCount,
          pageCount: candidate.pageCount,
          newPageCount: candidate.newPageUrls.length,
          coveragePercent: candidate.coveragePercent,
        },
        periods: undefined,
        sources: ["rank"],
        sourceRefs: {},
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData:
          candidate.coverageStatus === "ready"
            ? []
            : ["organic_coverage_partial"],
        confidenceInputs: {
          keywordCount: candidate.keywordCount,
          pageCount: candidate.pageCount,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: 50,
      coverageFlags: {
        organicCoverage: true,
        coverageStatus: candidate.coverageStatus,
      },
    });
  }
  return findings;
}

export const serpClusterNewPageDetector: DetectorDef = {
  detectorKey: "serp_cluster_new_page",
  version: 1,
  requiredSources: ["rank"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "rank", grains: ["serp_organic"], minCoverageRatio: 0.8 },
  ],
  detect: (ctx, input) => {
    if (!isSerpClusterNewPageInput(input)) {
      throw new Error("serp_cluster_new_page: mistyped input");
    }
    return detectSerpClusterNewPage(ctx, input);
  },
};
