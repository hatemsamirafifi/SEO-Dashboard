import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import { clusterSerpPages, type ClusterCoverage } from "./clusterCore";
import { SerpOrganicSnapshotRepository } from "./SerpOrganicSnapshotRepository";

/**
 * SERP clustering over the organic results the rank check already stored
 * (spec 019). Project-scoped, market- and device-scoped, and bounded by a
 * freshness window. The service never calls a provider.
 */

type SerpClusterDevice = "desktop" | "mobile";

type SerpClusterReport = {
  configId: string;
  device: SerpClusterDevice;
  market: {
    locationCode: number;
    locationName: string | null;
    languageCode: string;
    searchEngine: string;
  };
  coverage: ClusterCoverage;
  clusters: ReturnType<typeof clusterSerpPages>["clusters"];
  /** Forward-looking caveat the surface repeats verbatim. */
  caveat: string;
};

const SERP_CLUSTER_CAVEAT =
  "Forward-looking: these clusters reflect the organic results observed in the stored rank checks so far. They are a heuristic, not a prediction of how a page will rank.";

const DEFAULT_FRESHNESS_DAYS = 30;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_MIN_COVERAGE_RATIO = 0.8;

function freshnessCutoff(days: number, now: Date): string {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return cutoff.toISOString();
}

async function getClusters(input: {
  projectId: string;
  configId: string;
  device: SerpClusterDevice;
  threshold?: number;
  freshnessDays?: number;
  minCoverageRatio?: number;
  now?: Date;
}): Promise<SerpClusterReport> {
  const config = await RankTrackingRepository.getConfigById({
    configId: input.configId,
    projectId: input.projectId,
  });
  if (!config) throw new AppError("NOT_FOUND");

  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const freshnessDays = input.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const minCoverageRatio = input.minCoverageRatio ?? DEFAULT_MIN_COVERAGE_RATIO;
  const now = input.now ?? new Date();

  const [rows, trackedKeywords] = await Promise.all([
    SerpOrganicSnapshotRepository.getOrganicSnapshots({
      projectId: input.projectId,
      configId: input.configId,
      device: input.device,
      locationCode: config.locationCode,
      languageCode: config.languageCode,
      since: freshnessCutoff(freshnessDays, now),
    }),
    RankTrackingRepository.getKeywordCountForConfig(input.configId),
  ]);

  const byKeyword = new Map<
    string,
    {
      keyword: string;
      pages: Array<{
        url: string;
        normalizedUrl: string;
        domain: string | null;
        position: number;
      }>;
    }
  >();
  let freshestObservedAt: string | null = null;
  for (const row of rows) {
    if (freshestObservedAt === null || row.observedAt > freshestObservedAt) {
      freshestObservedAt = row.observedAt;
    }
    const entry = byKeyword.get(row.keyword) ?? {
      keyword: row.keyword,
      pages: [],
    };
    entry.pages.push({
      url: row.url,
      normalizedUrl: row.normalizedUrl,
      domain: row.domain,
      position: row.position,
    });
    byKeyword.set(row.keyword, entry);
  }

  const { clusters, coverage } = clusterSerpPages([...byKeyword.values()], {
    threshold,
    minCoverageRatio,
    trackedDomain: config.domain,
    trackedKeywordCount: trackedKeywords,
    freshestObservedAt,
  });

  return {
    configId: input.configId,
    device: input.device,
    market: {
      locationCode: config.locationCode,
      locationName: config.locationName,
      languageCode: config.languageCode,
      searchEngine: "google",
    },
    coverage,
    clusters,
    caveat: SERP_CLUSTER_CAVEAT,
  };
}

export const SerpClusteringService = { getClusters };
