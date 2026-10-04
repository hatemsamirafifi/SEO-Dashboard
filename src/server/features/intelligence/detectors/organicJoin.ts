import { canonicalUrl } from "@/shared/intelligence";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type {
  JoinGa4Page,
  JoinGscPage,
  JoinRankPage,
} from "../services/AnalyticsJoinService";

/**
 * Shared scan-time pre-fetch helpers for the organic page join (spec 010,
 * T021). These fetch stored rows ONLY — matching on canonical identity and
 * coverage gating happen in `joinUrlEvidence` and the detector fetchers that
 * call these helpers. No repository here is queried live from providers; all
 * reads are stored grains (G10). Rank "held" uses the same latest-two-runs
 * comparison shape as content_decay's agreement leg, but as its own gate
 * (held vs worsened is a different condition, not a second implementation of
 * the same concern).
 */

export type JoinWindow = { from: string; to: string };

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** GA4 landing rows for one window, shaped as join witnesses (sessions +
 *  engaged; goal sums have no page grain — research R5 — so they are never
 *  attached here). */
export async function fetchLandingJoinRows(input: {
  projectId: string;
  propertyId: string;
  current: JoinWindow;
  previous: JoinWindow;
  limit?: number;
}): Promise<JoinGa4Page[]> {
  const limit = input.limit ?? 1000;
  const [currentGroups, previousGroups] = await Promise.all([
    Ga4SyncRepository.getLandingGroups(
      input.projectId,
      input.propertyId,
      input.current.from,
      input.current.to,
      { limit },
    ),
    Ga4SyncRepository.getLandingGroups(
      input.projectId,
      input.propertyId,
      input.previous.from,
      input.previous.to,
      { limit },
    ),
  ]);
  const previousByPage = new Map<
    string,
    { sessions: number; engaged: number }
  >();
  for (const group of previousGroups) {
    previousByPage.set(group.landingPage, {
      sessions: group.sessions,
      engaged: group.engagedSessions,
    });
  }
  const rows: JoinGa4Page[] = [];
  const seen = new Set<string>();
  for (const group of currentGroups) {
    seen.add(group.landingPage);
    const older = previousByPage.get(group.landingPage) ?? {
      sessions: 0,
      engaged: 0,
    };
    rows.push({
      landingPage: group.landingPage,
      currentSessions: group.sessions,
      previousSessions: older.sessions,
      currentEngagedSessions: group.engagedSessions,
      previousEngagedSessions: older.engaged,
    });
  }
  for (const group of previousGroups) {
    if (seen.has(group.landingPage)) continue;
    rows.push({
      landingPage: group.landingPage,
      currentSessions: 0,
      previousSessions: group.sessions,
      currentEngagedSessions: 0,
      previousEngagedSessions: group.engagedSessions,
    });
  }
  return rows;
}

/** GSC page-grain rows summed per page over [from, to] for join presence and
 *  click context. Coverage gating stays with the caller (fetcher). */
export async function fetchGscJoinRows(input: {
  projectId: string;
  from: string;
  to: string;
}): Promise<Array<JoinGscPage & { factIds: string[] }>> {
  const facts = await GscSearchPerformanceRepository.getDailyGrainFacts(
    input.projectId,
    "page",
    input.from,
    input.to,
  );
  const byPage = new Map<
    string,
    { clicks: number; impressions: number; factIds: string[] }
  >();
  for (const fact of facts) {
    if (!fact.page) continue;
    const entry = byPage.get(fact.page) ?? {
      clicks: 0,
      impressions: 0,
      factIds: [],
    };
    entry.clicks += fact.clicks;
    entry.impressions += fact.impressions;
    if (entry.factIds.length < 200) entry.factIds.push(fact.id);
    byPage.set(fact.page, entry);
  }
  return [...byPage.entries()].map(([url, entry]) => ({
    url,
    clicks: entry.clicks,
    impressions: entry.impressions,
    factIds: entry.factIds,
  }));
}

/** Rank-held witnesses per canonical URL: `worsened` is true when the latest
 *  run's average position is worse (higher) than the prior run's — the same
 *  comparison content_decay uses for agreement, exposed here as the raw flag
 *  so the engagement detector can gate on held (!worsened). Rank
 *  unconfigured (or fewer than two qualifying runs) → available: false and
 *  no penalty. */
export async function fetchRankHeldRows(
  projectId: string,
): Promise<{ rows: JoinRankPage[]; available: boolean }> {
  const empty = { rows: [], available: false } as {
    rows: JoinRankPage[];
    available: boolean;
  };
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  const worsenedByUrl = new Map<string, boolean>();
  let available = false;
  for (const config of configs) {
    const runs = await RankTrackingRepository.getRecentRunsForConfig(
      config.id,
      5,
    );
    const qualifying: typeof runs = [];
    for (const run of runs) {
      if (run.status === "completed") {
        qualifying.push(run);
      } else if ((run.status as string) === "partial") {
        const snapshots = await RankTrackingRepository.getSnapshotsForRun(
          run.id,
        );
        if (snapshots.length > 0) qualifying.push(run);
      }
      if (qualifying.length >= 2) break;
    }
    if (qualifying.length < 2) continue;
    const [latest, prior] = qualifying;
    if (!latest || !prior) continue;
    const [latestSnaps, priorSnaps] = await Promise.all([
      RankTrackingRepository.getSnapshotsForRun(latest.id),
      RankTrackingRepository.getSnapshotsForRun(prior.id),
    ]);
    const priorByUrl = new Map<string, number[]>();
    for (const snap of priorSnaps) {
      if (snap.url == null || snap.position == null) continue;
      const key = canonicalUrl(snap.url);
      const list = priorByUrl.get(key) ?? [];
      list.push(snap.position);
      priorByUrl.set(key, list);
    }
    const latestByUrl = new Map<string, number[]>();
    for (const snap of latestSnaps) {
      if (snap.url == null || snap.position == null) continue;
      const key = canonicalUrl(snap.url);
      const list = latestByUrl.get(key) ?? [];
      list.push(snap.position);
      latestByUrl.set(key, list);
    }
    for (const [url, latestPositions] of latestByUrl) {
      const priorPositions = priorByUrl.get(url);
      if (!priorPositions || priorPositions.length === 0) continue;
      available = true;
      const worsened = average(latestPositions) > average(priorPositions);
      worsenedByUrl.set(url, (worsenedByUrl.get(url) ?? false) || worsened);
    }
  }
  if (!available) return empty;
  return {
    rows: [...worsenedByUrl.entries()].map(([url, worsened]) => ({
      url,
      worsened,
    })),
    available: true,
  };
}
