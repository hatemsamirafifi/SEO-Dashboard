import { canonicalUrl } from "@/shared/intelligence";

/**
 * Scan-time URL join across GSC, GA4, and rank evidence (final-plan §9.6:
 * "normalized-URL GSC×GA4×rank join, computed at scan time, nothing
 * persisted"). PURE: callers pre-fetch their source rows (detector input
 * fetchers); this module only matches them on canonical page identity and
 * reports per-source presence (the join coverage gate). Imports no
 * repositories — enforced by the import-ban test.
 */

export type JoinGscPage = { url: string; clicks: number; impressions: number };

export type JoinGa4Page = {
  landingPage: string;
  currentSessions: number;
  previousSessions: number;
};

export type JoinRankPage = { url: string; worsened: boolean };

export type JoinedUrlRow = {
  url: string;
  gscClicks: number | null;
  ga4Sessions: { current: number; previous: number } | null;
  rankWorsened: boolean | null;
  present: { gsc: boolean; ga4: boolean; rank: boolean };
};

export function joinUrlEvidence(input: {
  gsc?: JoinGscPage[];
  ga4?: JoinGa4Page[];
  rank?: JoinRankPage[];
}): JoinedUrlRow[] {
  const byUrl = new Map<
    string,
    {
      gscClicks: number | null;
      ga4Sessions: { current: number; previous: number } | null;
      rankWorsened: boolean | null;
    }
  >();
  const bucket = (url: string) => {
    const key = canonicalUrl(url);
    let entry = byUrl.get(key);
    if (!entry) {
      entry = { gscClicks: null, ga4Sessions: null, rankWorsened: null };
      byUrl.set(key, entry);
    }
    return { key, entry };
  };
  for (const row of input.gsc ?? []) {
    const { entry } = bucket(row.url);
    entry.gscClicks = (entry.gscClicks ?? 0) + row.clicks;
  }
  for (const row of input.ga4 ?? []) {
    const { entry } = bucket(row.landingPage);
    const current = entry.ga4Sessions ?? { current: 0, previous: 0 };
    current.current += row.currentSessions;
    current.previous += row.previousSessions;
    entry.ga4Sessions = current;
  }
  for (const row of input.rank ?? []) {
    const { entry } = bucket(row.url);
    entry.rankWorsened = (entry.rankWorsened ?? false) || row.worsened;
  }
  return [...byUrl.entries()]
    .map(([url, entry]) => ({
      url,
      gscClicks: entry.gscClicks,
      ga4Sessions: entry.ga4Sessions,
      rankWorsened: entry.rankWorsened,
      present: {
        gsc: entry.gscClicks !== null,
        ga4: entry.ga4Sessions !== null,
        rank: entry.rankWorsened !== null,
      },
    }))
    .toSorted((a, b) => (a.url < b.url ? -1 : 1));
}

export type JoinCoverage = {
  urlCount: number;
  gscCovered: number;
  ga4Covered: number;
  rankCovered: number;
};

/** Per-source join coverage over the joined rows (the join coverage gate). */
export function summarizeJoinCoverage(rows: JoinedUrlRow[]): JoinCoverage {
  return {
    urlCount: rows.length,
    gscCovered: rows.filter((row) => row.present.gsc).length,
    ga4Covered: rows.filter((row) => row.present.ga4).length,
    rankCovered: rows.filter((row) => row.present.rank).length,
  };
}
