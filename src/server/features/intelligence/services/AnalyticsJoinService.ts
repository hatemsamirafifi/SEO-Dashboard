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
  // Spec 010 (contracts/organic-join.md): optional engagement/goal witnesses.
  // A missing field means "no coverage for that measure" — the output stays
  // null (never 0), so callers can pass sparse rows from partial coverage.
  currentEngagedSessions?: number;
  previousEngagedSessions?: number;
  currentGoalConversions?: number;
  previousGoalConversions?: number;
};

export type JoinRankPage = { url: string; worsened: boolean };

export type JoinedUrlRow = {
  url: string;
  gscClicks: number | null;
  ga4Sessions: { current: number; previous: number } | null;
  rankWorsened: boolean | null;
  present: { gsc: boolean; ga4: boolean; rank: boolean };
  // Spec 010: engagement rate as ratio-of-sums (never averaged daily rates).
  // Null when GA4 is absent for the page OR either window's sessions
  // denominator is 0 (0/0 is undefined engagement — null, not 0).
  ga4Engagement: {
    currentRate: number;
    previousRate: number;
    currentEngagedSessions: number;
    previousEngagedSessions: number;
  } | null;
  // Spec 010: goal-scoped additive event sums, per the goal binding the
  // caller filtered on. Null when GA4 is absent for the page.
  ga4GoalConversions: { current: number; previous: number } | null;
};

export function joinUrlEvidence(input: {
  gsc?: JoinGscPage[];
  ga4?: JoinGa4Page[];
  rank?: JoinRankPage[];
  /**
   * Project host context (spec 006) used to resolve path-only rows (GA4
   * landing pages) into full page identities. Full URLs resolve from their
   * own host and ignore this. Absent → path-only rows stay path-scoped and
   * never inherit an invented host.
   */
  hostContext?: string | null;
}): JoinedUrlRow[] {
  const byUrl = new Map<
    string,
    {
      gscClicks: number | null;
      ga4Sessions: { current: number; previous: number } | null;
      rankWorsened: boolean | null;
      ga4EngagementAcc: {
        currentEngaged: number;
        previousEngaged: number;
      } | null;
      ga4GoalAcc: { current: number; previous: number } | null;
    }
  >();
  const bucket = (url: string) => {
    const key = canonicalUrl(url, input.hostContext);
    let entry = byUrl.get(key);
    if (!entry) {
      entry = {
        gscClicks: null,
        ga4Sessions: null,
        rankWorsened: null,
        ga4EngagementAcc: null,
        ga4GoalAcc: null,
      };
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
    if (
      row.currentEngagedSessions !== undefined ||
      row.previousEngagedSessions !== undefined
    ) {
      const acc = entry.ga4EngagementAcc ?? {
        currentEngaged: 0,
        previousEngaged: 0,
      };
      acc.currentEngaged += row.currentEngagedSessions ?? 0;
      acc.previousEngaged += row.previousEngagedSessions ?? 0;
      entry.ga4EngagementAcc = acc;
    }
    if (
      row.currentGoalConversions !== undefined ||
      row.previousGoalConversions !== undefined
    ) {
      const acc = entry.ga4GoalAcc ?? { current: 0, previous: 0 };
      acc.current += row.currentGoalConversions ?? 0;
      acc.previous += row.previousGoalConversions ?? 0;
      entry.ga4GoalAcc = acc;
    }
  }
  for (const row of input.rank ?? []) {
    const { entry } = bucket(row.url);
    entry.rankWorsened = (entry.rankWorsened ?? false) || row.worsened;
  }
  return [...byUrl.entries()]
    .map(([url, entry]) => {
      const sessions = entry.ga4Sessions;
      const engagementAcc = entry.ga4EngagementAcc;
      const ga4Engagement =
        sessions && engagementAcc &&
        sessions.current > 0 &&
        sessions.previous > 0
          ? {
              currentRate: engagementAcc.currentEngaged / sessions.current,
              previousRate: engagementAcc.previousEngaged / sessions.previous,
              currentEngagedSessions: engagementAcc.currentEngaged,
              previousEngagedSessions: engagementAcc.previousEngaged,
            }
          : null;
      return {
        url,
        gscClicks: entry.gscClicks,
        ga4Sessions: entry.ga4Sessions,
        rankWorsened: entry.rankWorsened,
        present: {
          gsc: entry.gscClicks !== null,
          ga4: entry.ga4Sessions !== null,
          rank: entry.rankWorsened !== null,
        },
        ga4Engagement,
        ga4GoalConversions: entry.ga4GoalAcc,
      };
    })
    .toSorted((a, b) => (a.url < b.url ? -1 : 1));
}

export type JoinCoverage = {
  urlCount: number;
  gscCovered: number;
  ga4Covered: number;
  rankCovered: number;
  // Spec 010: consumer gating for the engagement/goal measures.
  ga4EngagementCovered: number;
  ga4GoalCovered: number;
};

/** Per-source join coverage over the joined rows (the join coverage gate). */
export function summarizeJoinCoverage(rows: JoinedUrlRow[]): JoinCoverage {
  return {
    urlCount: rows.length,
    gscCovered: rows.filter((row) => row.present.gsc).length,
    ga4Covered: rows.filter((row) => row.present.ga4).length,
    rankCovered: rows.filter((row) => row.present.rank).length,
    ga4EngagementCovered: rows.filter((row) => row.ga4Engagement !== null)
      .length,
    ga4GoalCovered: rows.filter((row) => row.ga4GoalConversions !== null)
      .length,
  };
}
