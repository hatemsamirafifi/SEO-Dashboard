import { canonicalKeyword } from "@/shared/intelligence";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
} from "./types";
import { coverageRatio, splitWindows, type GscWindow } from "./gscWindows";
import {
  normalizedPage,
  type CannibalizationCandidate,
  type CannibalizationInput,
} from "./cannibalization";

/**
 * Spec 018 input layer: the current window of GSC query_page facts plus the
 * immediately preceding window of the same length, so the detector can see
 * which URLs started or stopped serving a query. Coverage follows the
 * repository's GSC semantics - a synced window with empty days is covered, an
 * unsynced window is not covered and never reads as "no overlap".
 */

type GscFactRows = Awaited<
  ReturnType<typeof GscSearchPerformanceRepository.getDailyGrainFacts>
>;

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

/** Distinct queries observed per URL inside one window. */
type UrlQuerySets = Map<string, Set<string>>;

function querySetsByUrl(rows: GscFactRows, window: GscWindow): UrlQuerySets {
  const sets: UrlQuerySets = new Map();
  for (const row of rows) {
    if (!row.query || !row.page) continue;
    if (row.date < window.from || row.date > window.to) continue;
    const url = normalizedPage(row.page) ?? row.page;
    let queries = sets.get(url);
    if (!queries) {
      queries = new Set();
      sets.set(url, queries);
    }
    queries.add(canonicalKeyword(row.query));
  }
  return sets;
}

/**
 * Overlap coefficient of the two observed query sets: the share of the
 * smaller set both URLs serve (1 = identical query spaces).
 */
function querySetOverlap(
  sets: UrlQuerySets,
  first: string,
  second: string,
): { overlap: number; counts: [number, number] } {
  const left = sets.get(first);
  const right = sets.get(second);
  const leftSize = left?.size ?? 0;
  const rightSize = right?.size ?? 0;
  if (leftSize === 0 || rightSize === 0) {
    return { overlap: 0, counts: [leftSize, rightSize] };
  }
  let shared = 0;
  const smaller = leftSize <= rightSize ? left : right;
  const larger = leftSize <= rightSize ? right : left;
  for (const query of smaller ?? []) {
    if (larger?.has(query)) shared += 1;
  }
  return {
    overlap: shared / Math.min(leftSize, rightSize),
    counts: [leftSize, rightSize],
  };
}

/**
 * Coverage per the repository's GSC semantics: a window covered by a
 * completed or partial sync is covered even when a day has no rows, and a
 * window that was never synced (or whose sync failed) is not covered - it must
 * never be read as "no overlap". The day-presence ratio stays as the
 * fallback signal for legacy data without sync metadata.
 */
async function isWindowCovered(
  projectId: string,
  window: GscWindow,
  rows: GscFactRows,
  minCoverage: number,
): Promise<boolean> {
  if (coverageRatio(rows, window) >= minCoverage) return true;
  return GscSearchPerformanceRepository.hasCoverage(
    projectId,
    window.from,
    window.to,
  );
}

export async function fetchCannibalizationInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<CannibalizationInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const maxEvidenceRows = thresholdNumber(ctx.thresholds, "maxEvidenceRows");
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "query_page",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "cannibalization: no GSC query_page facts",
    );
  }
  const { current, previous } = splitWindows(latestDate, windowDays);
  const fromStr = current.from;
  const to = current.to;
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "query_page",
    fromStr,
    to,
  );
  const window = { from: fromStr, to };
  if (!(await isWindowCovered(projectId, window, rows, minCoverage))) {
    throw new InsufficientCoverageError(
      `cannibalization: query_page coverage below ${minCoverage} ` +
        `for ${fromStr}..${to}`,
    );
  }
  const priorRows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "query_page",
    previous.from,
    previous.to,
  );
  const priorCovered = await isWindowCovered(
    projectId,
    previous,
    priorRows,
    minCoverage,
  );
  const urlQueries = querySetsByUrl(rows, window);
  const priorUrlsByQuery = new Map<string, Set<string>>();
  for (const row of priorRows) {
    if (!row.query || !row.page) continue;
    if (row.date < previous.from || row.date > previous.to) continue;
    const query = canonicalKeyword(row.query);
    let urls = priorUrlsByQuery.get(query);
    if (!urls) {
      urls = new Set();
      priorUrlsByQuery.set(query, urls);
    }
    urls.add(normalizedPage(row.page) ?? row.page);
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
    const urls = ranked.map(([url]) => url);
    const overlap = querySetOverlap(urlQueries, urls[0] ?? "", urls[1] ?? "");
    const priorUrls = [...(priorUrlsByQuery.get(query) ?? [])].toSorted();
    const priorSet = new Set(priorUrls);
    const currentSet = new Set(urls);
    candidates.push({
      query,
      urls,
      urlImpressions: ranked.map(([, entry]) => entry.impressions),
      queryImpressions: total,
      topShare: total > 0 ? (ranked[0]?.[1].impressions ?? 0) / total : 0,
      factIds: ranked
        .flatMap(([, entry]) => entry.factIds)
        .slice(0, maxEvidenceRows),
      rankWitnessOnly: false,
      urlQueryOverlap: overlap.overlap,
      urlQueryCounts: overlap.counts,
      priorUrls,
      priorCovered,
      shiftedIn: urls.filter((url) => !priorSet.has(url)),
      shiftedOut: priorUrls.filter((url) => !currentSet.has(url)),
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
        urlQueryOverlap: 0,
        urlQueryCounts: [0, 0],
        priorUrls: [],
        priorCovered,
        shiftedIn: [],
        shiftedOut: [],
      });
    }
  }
  return {
    periodFrom: fromStr,
    periodTo: to,
    periodFromPrior: previous.from,
    periodToPrior: previous.to,
    candidates,
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      minUrls: thresholdNumber(ctx.thresholds, "minUrls"),
      minImpressions: thresholdNumber(ctx.thresholds, "minImpressions"),
      dominantShare: thresholdNumber(ctx.thresholds, "dominantShare"),
      intentOverlapMax: thresholdNumber(ctx.thresholds, "intentOverlapMax"),
      maxEvidenceRows,
    },
  };
}
