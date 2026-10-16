/* eslint-disable max-lines, max-lines-per-function, complexity */
import { canonicalKeyword } from "@/shared/intelligence";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  getLatestCompetitorSnapshotsForProject,
  getProjectDomain,
  getKeywordSearchVolumes,
} from "@/server/lib/seo-data/competitor-snapshot-repository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import { coverageRatio, splitWindows, type GscWindow } from "./gscWindows";

export type CompetitorObservation = {
  domain: string;
  position: number;
  url?: string;
};

export type CompetitorGapRow = {
  keyword: string;
  searchVolume: number;
  competitors: CompetitorObservation[];
  firstPartyPosition: number | null;
  firstPartyUrl: string | null;
  factIds: string[];
};

export type CompetitorGapInput = {
  periodFrom: string;
  periodTo: string;
  rows: CompetitorGapRow[];
  thresholds: Record<string, string | number | boolean>;
};

export function isCompetitorGapInput(
  value: unknown,
): value is CompetitorGapInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export function extractCompetitorPosition(
  item: unknown,
  keyword: string,
): number | null {
  if (typeof item !== "object" || item === null) return null;

  // 1. Check keywords_positions dictionary for this specific keyword (DataForSEO standard contract)
  // Contract: keywords_positions is an object where values can be an array of positions e.g. [1, 3] or scalar.
  if (
    "keywords_positions" in item &&
    typeof item.keywords_positions === "object" &&
    item.keywords_positions !== null
  ) {
    const kp = item.keywords_positions as Record<string, unknown>;
    const targetCanonical = canonicalKeyword(keyword);
    for (const [kwKey, posVal] of Object.entries(kp)) {
      if (canonicalKeyword(kwKey) !== targetCanonical) continue;
      if (Array.isArray(posVal)) {
        const validNums = posVal.filter(
          (p): p is number =>
            typeof p === "number" && Number.isInteger(p) && p >= 1,
        );
        return validNums.length > 0 ? Math.min(...validNums) : null;
      }
      if (
        typeof posVal === "number" &&
        Number.isInteger(posVal) &&
        posVal >= 1
      ) {
        return posVal;
      }
    }
  }

  // 2. Direct per-keyword position field (e.g. from single-keyword SERP item or fixture)
  if (
    "position" in item &&
    typeof item.position === "number" &&
    Number.isInteger(item.position) &&
    item.position >= 1
  ) {
    return item.position;
  }

  // Invariant: NEVER infer keyword-level ranking from domain-level avg_position!
  return null;
}


export async function fetchCompetitorGapInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<CompetitorGapInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const minVolume = thresholdNumber(ctx.thresholds, "minVolume");

  const snapshots = await getLatestCompetitorSnapshotsForProject(projectId, 10);
  if (snapshots.length === 0) {
    throw new InsufficientCoverageError(
      "competitor_gap: no stored competitor snapshots found",
    );
  }

  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "query",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError("competitor_gap: no GSC query facts");
  }

  const newestFetchedAt = snapshots[0]?.fetchedAt;
  const referenceMs = Date.parse(latestDate);
  const snapshotMs = newestFetchedAt ? Date.parse(newestFetchedAt) : NaN;
  const maxAgeMs = windowDays * 2 * 86_400_000;
  if (
    !Number.isFinite(snapshotMs) ||
    Math.abs(referenceMs - snapshotMs) > maxAgeMs
  ) {
    throw new InsufficientCoverageError(
      `competitor_gap: newest snapshot older than ${windowDays * 2}d`,
    );
  }

  const projectDomain =
    (await getProjectDomain(projectId))?.toLowerCase() ?? null;
  const volumeMap = await getKeywordSearchVolumes(projectId);

  const { current, previous } = splitWindows(latestDate, windowDays);
  const facts = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "query",
    previous.from,
    current.to,
  );

  for (const window of [current, previous] as GscWindow[]) {
    if (coverageRatio(facts, window) < minCoverage) {
      throw new InsufficientCoverageError(
        `competitor_gap: query coverage below ${minCoverage} for ${window.from}..${window.to}`,
      );
    }
  }

  // Aggregate first-party performance by canonical query
  const firstPartyMap = new Map<
    string,
    { positionWeighted: number; impressions: number; factIds: string[] }
  >();
  for (const fact of facts) {
    if (fact.date < current.from || fact.date > current.to) continue;
    const key = canonicalKeyword(fact.query ?? fact.grainKey);
    const existing = firstPartyMap.get(key) ?? {
      positionWeighted: 0,
      impressions: 0,
      factIds: [],
    };
    existing.positionWeighted += fact.position * fact.impressions;
    existing.impressions += fact.impressions;
    if (existing.factIds.length < 50) existing.factIds.push(fact.id);
    firstPartyMap.set(key, existing);
  }

  const rows: CompetitorGapRow[] = [];
  const seenKeywords = new Set<string>();

  for (const snap of snapshots) {
    for (const rawKw of snap.keywords) {
      const canonical = canonicalKeyword(rawKw);
      if (seenKeywords.has(canonical)) continue;
      seenKeywords.add(canonical);

      const competitors: CompetitorObservation[] = [];
      let serpFirstPartyPosition: number | null = null;
      let projectDomainSeenInItems = false;

      for (const item of snap.items) {
        if (typeof item !== "object" || item === null) continue;
        const domain =
          "domain" in item && typeof item.domain === "string"
            ? item.domain
            : null;
        if (!domain) continue;

        const isFirstParty =
          Boolean(projectDomain) && domain.toLowerCase() === projectDomain;
        if (isFirstParty) {
          projectDomainSeenInItems = true;
        }

        const pos = extractCompetitorPosition(item, rawKw);
        if (pos === null) continue;

        if (isFirstParty) {
          serpFirstPartyPosition = pos;
        } else {
          const url =
            "url" in item && typeof item.url === "string"
              ? item.url
              : undefined;
          competitors.push({ domain, position: pos, url });
        }
      }

      if (competitors.length === 0) continue;
      competitors.sort((a, b) => a.position - b.position);

      const fp = firstPartyMap.get(canonical);
      const gscPosition =
        fp && fp.impressions > 0 ? fp.positionWeighted / fp.impressions : null;
      const firstPartyPosition = serpFirstPartyPosition ?? gscPosition;

      // Invariant: Do not infer that our domain is absent from the SERP solely because a GSC query fact is missing.
      // Furthermore, DataForSEO SERP Competitors returns a bounded domain list with limit, total_count, and items_count.
      // Absence of the first-party domain from a truncated competitor list does not prove absence from the SERP.
      // Only assert first-party SERP absence when an appropriate complete/coverage-qualified SERP observation supports it.
      // Otherwise classify evidence as insufficient and skip the unsupported finding.
      if (firstPartyPosition === null) {
        if (!projectDomain) {
          // Cannot verify absence from SERP without project domain — skip
          continue;
        }
        if (projectDomainSeenInItems) {
          // Domain appeared in SERP snapshot but ranking position was indeterminate — skip
          continue;
        }
        // Verify snapshot completeness: if totalCount > itemsCount (or items.length), the list is truncated.
        // A truncated competitor list does not prove first-party absence.
        const isCoverageQualified =
          snap.totalCount !== null &&
          snap.totalCount !== undefined &&
          snap.totalCount <= (snap.itemsCount ?? snap.items.length);
        if (!isCoverageQualified) {
          // Incomplete or unqualified SERP observation — skip unsupported finding
          continue;
        }
      }

      // Search volume: GSC impressions first, then keyword_metrics table
      const searchVolume =
        fp && fp.impressions > 0
          ? fp.impressions
          : (volumeMap.get(canonical) ?? 0);
      if (searchVolume < minVolume) {
        // Sufficient search volume evidence is unavailable — skip unsupported finding
        continue;
      }

      rows.push({
        keyword: canonical,
        searchVolume,
        competitors,
        firstPartyPosition,
        firstPartyUrl: null,
        factIds: fp ? fp.factIds : [],
      });
    }
  }

  return {
    periodFrom: current.from,
    periodTo: current.to,
    rows,
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      minCompetitorRank: thresholdNumber(ctx.thresholds, "minCompetitorRank"),
      maxFirstPartyPosition: thresholdNumber(
        ctx.thresholds,
        "maxFirstPartyPosition",
      ),
      minVolume: thresholdNumber(ctx.thresholds, "minVolume"),
    },
  };
}

export function detectCompetitorGap(
  ctx: DetectorContext,
  input: CompetitorGapInput,
): FindingDraft[] {
  const minCompetitorRank = thresholdNumber(
    ctx.thresholds,
    "minCompetitorRank",
  );
  const maxFirstPartyPosition = thresholdNumber(
    ctx.thresholds,
    "maxFirstPartyPosition",
  );
  const minVolume = thresholdNumber(ctx.thresholds, "minVolume");

  const findings: FindingDraft[] = [];

  for (const row of input.rows) {
    if (row.searchVolume < minVolume) continue;
    if (row.competitors.length === 0) continue;

    const sortedCompetitors = row.competitors.toSorted(
      (a, b) => a.position - b.position,
    );
    const topCompetitor = sortedCompetitors[0];
    if (!topCompetitor || topCompetitor.position > minCompetitorRank) continue;

    // If first party already ranks better or within threshold, no gap exists
    if (
      row.firstPartyPosition !== null &&
      row.firstPartyPosition <= maxFirstPartyPosition
    ) {
      continue;
    }

    const volumeLabel = row.searchVolume.toLocaleString("en-US");
    const firstPartyText =
      row.firstPartyPosition !== null
        ? `ranks at position ${row.firstPartyPosition.toFixed(1)}.`
        : "is absent from top search results.";

    const explanationFact =
      `Competitor "${topCompetitor.domain}" ranks at position ` +
      `${topCompetitor.position.toFixed(1)} for "${row.keyword}" ` +
      `(search volume: ${volumeLabel}), while our domain ${firstPartyText}`;

    let confidenceScore = 60;
    if (topCompetitor.position <= 3) confidenceScore += 10;
    if (sortedCompetitors.length > 1) confidenceScore += 5;
    if (row.searchVolume >= 500) confidenceScore += 5;

    findings.push({
      entityKey: canonicalKeyword(row.keyword),
      entity: {
        keyword: row.keyword,
        competitorDomain: topCompetitor.domain,
        competitorPosition: topCompetitor.position,
        competitorUrl: topCompetitor.url,
        firstPartyPosition: row.firstPartyPosition ?? undefined,
        targetUrl: row.firstPartyUrl ?? undefined,
      },
      explanationFact,
      evidence: {
        metrics: {
          searchVolume: row.searchVolume,
          competitorPosition: topCompetitor.position,
          competitorCount: sortedCompetitors.length,
          firstPartyPosition: row.firstPartyPosition ?? 0,
          hasFirstPartyRank: row.firstPartyPosition !== null,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: ["rank", "gsc"],
        sourceRefs: { gscFactIds: row.factIds },
        thresholdsApplied: input.thresholds,
        correlations: sortedCompetitors.slice(1).map((comp) => ({
          entityRef: comp.domain,
          note: `Competitor "${comp.domain}" also observed at position ${comp.position.toFixed(1)}`,
        })),
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: {
          competitorRank: topCompetitor.position,
          volumeMultiple: row.searchVolume / Math.max(1, minVolume),
          competitorCount: sortedCompetitors.length,
          hasFirstPartyData: row.firstPartyPosition !== null ? 1 : 0,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore,
      coverageFlags: {
        competitorCoverage: true,
        firstPartyCoverage: row.firstPartyPosition !== null,
      },
    });
  }

  return findings;
}

export const competitorGapDetector: DetectorDef = {
  detectorKey: "competitor_gap",
  version: 1,
  requiredSources: ["rank", "gsc"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [{ source: "gsc", grains: ["query"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isCompetitorGapInput(input)) {
      throw new Error("competitor_gap: mistyped input");
    }
    return detectCompetitorGap(ctx, input);
  },
};
