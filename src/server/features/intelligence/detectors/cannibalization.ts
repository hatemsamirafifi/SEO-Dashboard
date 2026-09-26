import {
  canonicalCannibalizationPair,
  canonicalKeyword,
  canonicalUrl,
} from "@/shared/intelligence";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { coverageRatio } from "./gscWindows";

/**
 * `cannibalization` (final-plan §4): ≥2 URLs earning impressions for the
 * same query in an overlapping window (GSC query_page grain, or rank
 * overlap). Always worded "potential": overlap is observed, intent is not.
 * GA4 absence carries no penalty.
 */

export type CannibalizationCandidate = {
  query: string;
  /** Impression-descending URLs with parallel impression counts. */
  urls: string[];
  urlImpressions: number[];
  queryImpressions: number;
  topShare: number;
  factIds: string[];
  /** True when the pair comes from rank overlap without GSC facts. */
  rankWitnessOnly: boolean;
};

export type CannibalizationInput = {
  periodFrom: string;
  periodTo: string;
  candidates: CannibalizationCandidate[];
  thresholds: Record<string, string | number | boolean>;
};

export function isCannibalizationInput(
  value: unknown,
): value is CannibalizationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "candidates" in value &&
    Array.isArray(value.candidates) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

function normalizedPage(url: string | null): string | null {
  if (!url) return null;
  // One shared helper for grouping, keys, joins, and opportunities.
  return canonicalUrl(url);
}

type RankRunRow = Awaited<
  ReturnType<typeof RankTrackingRepository.getRecentRunsForConfig>
>[number];

/** Newest run with committed snapshots (completed, or partial with rows). */
async function latestQualifyingRankRun(
  configId: string,
): Promise<RankRunRow | null> {
  const runs = await RankTrackingRepository.getRecentRunsForConfig(configId, 6);
  for (const run of runs) {
    if (run.status === "completed") return run;
    if ((run.status as string) === "partial") {
      const snapshots = await RankTrackingRepository.getSnapshotsForRun(run.id);
      if (snapshots.length > 0) return run;
    }
  }
  return null;
}

export async function fetchCannibalizationInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<CannibalizationInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "query_page",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "cannibalization: no GSC query_page facts",
    );
  }
  const to = latestDate;
  const from = new Date(`${to}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (windowDays - 1));
  const fromStr = from.toISOString().slice(0, 10);
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "query_page",
    fromStr,
    to,
  );
  const window = { from: fromStr, to };
  if (coverageRatio(rows, window) < minCoverage) {
    throw new InsufficientCoverageError(
      `cannibalization: query_page coverage below ${minCoverage} ` +
        `for ${fromStr}..${to}`,
    );
  }
  const byQuery = new Map<
    string,
    Map<string, { impressions: number; factIds: string[] }>
  >();
  for (const row of rows) {
    if (!row.query || !row.page) continue;
    const query = canonicalKeyword(row.query);
    let pages = byQuery.get(query);
    if (!pages) {
      pages = new Map();
      byQuery.set(query, pages);
    }
    const normalized = normalizedPage(row.page) ?? row.page;
    const entry = pages.get(normalized) ?? { impressions: 0, factIds: [] };
    entry.impressions += row.impressions;
    if (entry.factIds.length < 100) entry.factIds.push(row.id);
    pages.set(normalized, entry);
  }
  // Rank overlap as a second witness: same keyword, ≥2 distinct ranking URLs
  // in the latest qualifying run per config.
  const rankOverlap = new Map<string, string[]>();
  try {
    const configs =
      await RankTrackingRepository.getConfigsForProject(projectId);
    for (const config of configs) {
      const chosen = await latestQualifyingRankRun(config.id);
      if (!chosen) continue;
      const snapshots = await RankTrackingRepository.getSnapshotsForRun(
        chosen.id,
      );
      const urlsByKeyword = new Map<string, Set<string>>();
      for (const snap of snapshots) {
        if (snap.rankingStatus !== "RANKED" || !snap.url) continue;
        const key = canonicalKeyword(snap.keyword);
        let urls = urlsByKeyword.get(key);
        if (!urls) {
          urls = new Set();
          urlsByKeyword.set(key, urls);
        }
        const normalized = normalizedPage(snap.url) ?? snap.url;
        urls.add(normalized);
      }
      for (const [key, urls] of urlsByKeyword) {
        if (urls.size >= 2) {
          rankOverlap.set(key, [...urls].toSorted());
        }
      }
    }
  } catch {
    // Rank overlap is corroboration only; its failure never blocks GSC.
  }
  const candidates: CannibalizationCandidate[] = [];
  for (const [query, pages] of byQuery) {
    const ranked = [...pages.entries()].toSorted(
      ([, a], [, b]) => b.impressions - a.impressions,
    );
    const total = ranked.reduce((sum, [, entry]) => sum + entry.impressions, 0);
    candidates.push({
      query,
      urls: ranked.map(([url]) => url),
      urlImpressions: ranked.map(([, entry]) => entry.impressions),
      queryImpressions: total,
      topShare: total > 0 ? (ranked[0]?.[1].impressions ?? 0) / total : 0,
      factIds: ranked.flatMap(([, entry]) => entry.factIds).slice(0, 200),
      rankWitnessOnly: false,
    });
  }
  // Merge rank-only witnesses (queries with rank overlap but no GSC pair).
  for (const [query, urls] of rankOverlap) {
    if (!byQuery.has(query)) {
      candidates.push({
        query,
        urls,
        urlImpressions: urls.map(() => 0),
        queryImpressions: 0,
        topShare: 0,
        factIds: [],
        rankWitnessOnly: true,
      });
    }
  }
  return {
    periodFrom: fromStr,
    periodTo: to,
    candidates,
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      minUrls: thresholdNumber(ctx.thresholds, "minUrls"),
      minImpressions: thresholdNumber(ctx.thresholds, "minImpressions"),
    },
  };
}

export function detectCannibalization(
  ctx: DetectorContext,
  input: CannibalizationInput,
): FindingDraft[] {
  const minUrls = thresholdNumber(ctx.thresholds, "minUrls");
  const minImpressions = thresholdNumber(ctx.thresholds, "minImpressions");
  const findings: FindingDraft[] = [];
  for (const candidate of input.candidates) {
    // Both URLs above the impression floor. Rank-only witnesses carry no
    // GSC impressions — they still qualify as "potential" when the URL
    // count holds, labeled via partialData.
    const qualified = candidate.urls.filter(
      (_, index) =>
        candidate.rankWitnessOnly ||
        (candidate.urlImpressions[index] ?? 0) >= minImpressions,
    );
    if (qualified.length < minUrls) continue;
    const [first, second] = qualified.slice(0, 2);
    if (!first || !second) continue;
    const entityKey = canonicalCannibalizationPair(
      first,
      second,
      candidate.query,
    );
    findings.push({
      entityKey,
      entity: {
        query: candidate.query,
        urlA: first,
        urlB: second,
      },
      explanationFact:
        `Potential cannibalization: "${candidate.query}" is served by both ` +
        `${first} and ${second} in ${input.periodFrom}..${input.periodTo} ` +
        `(overlap observed; intent not determined).`,
      evidence: {
        metrics: {
          queryImpressions: candidate.queryImpressions,
          urlCount: candidate.urls.length,
          topShare: candidate.topShare,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: candidate.factIds.length > 0 ? ["gsc", "rank"] : ["rank"],
        sourceRefs: { gscFactIds: candidate.factIds },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: candidate.rankWitnessOnly ? ["rank_witness_only"] : [],
        confidenceInputs: {
          urlCount: candidate.urls.length,
          rankWitnessOnly: candidate.rankWitnessOnly,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: 55,
      coverageFlags: { queryPageCoverage: true },
    });
  }
  return findings;
}

export const cannibalizationDetector: DetectorDef = {
  detectorKey: "cannibalization",
  version: 1,
  requiredSources: ["gsc"],
  optionalCorroborators: ["rank"],
  minConfidenceToEmit: 40,
  coverage: [{ source: "gsc", grains: ["query_page"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isCannibalizationInput(input)) {
      throw new Error("cannibalization: mistyped input");
    }
    return detectCannibalization(ctx, input);
  },
};
