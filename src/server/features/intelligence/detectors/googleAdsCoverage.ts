import { eq } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections } from "@/db/schema";
import { GoogleAdsAnalyticsRepository } from "@/server/features/google-ads/repositories/GoogleAdsAnalyticsRepository";
import {
  type GoogleAdsGrain,
  type GoogleAdsUnitScope,
} from "@/server/features/google-ads/repositories/googleAdsAnalyticsModel";
import { inWindow, splitWindows, type GscWindow } from "./gscWindows";
import { InsufficientCoverageError } from "./types";

/**
 * Shared Google Ads stored-evidence loader for intelligence detectors
 * (master plan phase 5). Reads ONLY already-synchronized, published unit
 * coverage — never the live Google Ads API, never campaigns. Window anchors
 * come from repository facts (GSC latest fact date or the latest covered Ads
 * unit), never wall clock, matching the gscWindows conventions (§A4).
 */

const SUCCESS_STATUSES = new Set(["success_with_data", "success_zero_rows"]);

export type GoogleAdsScopeInput = {
  projectId: string;
  organizationId: string;
  grains: readonly GoogleAdsGrain[];
  windowDays: number;
  minCoverageRatio: number;
  /**
   * Optional external window anchor (ISO date), e.g. the latest GSC query
   * fact date for cross-source alignment. Absent → the latest covered Ads
   * unit date anchors the window.
   */
  anchorDate?: string;
};

export type GoogleAdsCoverageLoad = {
  scope: GoogleAdsUnitScope;
  customerId: string;
  accountId: string;
  /** Account currency snapshot; null = not yet observed (explicit unknown). */
  currencyCode: string | null;
  /** Observed metric-date basis for the loaded grains; null = unit unset. */
  metricDateBasis: string | null;
  window: GscWindow;
  windowDays: number;
  /** Minimum per-grain covered-day ratio across the requested grains. */
  coverageRatio: number;
  /** grain → sorted `customerId:date:grain` refs for covered units in window. */
  coveredUnitRefsByGrain: Map<string, string[]>;
};

/**
 * Load the project's currently selected Ads customer, verify success_* unit
 * coverage for every requested grain across the window, and surface the
 * account currency plus metric-date basis for evidence mirrors. Throws
 * InsufficientCoverageError (a skip reason, never a failure) when no
 * connection exists, no covered unit exists, or a grain's covered-day ratio
 * falls below the threshold.
 */
export async function loadGoogleAdsCoverage(
  input: GoogleAdsScopeInput,
): Promise<GoogleAdsCoverageLoad> {
  const connectionRows = await db
    .select({
      id: googleAdsConnections.id,
      customerId: googleAdsConnections.customerId,
    })
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, input.projectId))
    .limit(2);
  const connection = connectionRows[0];
  if (!connection) {
    throw new InsufficientCoverageError("google_ads: not connected");
  }
  const scope: GoogleAdsUnitScope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    customerId: connection.customerId,
  };
  const pointers = await GoogleAdsAnalyticsRepository.listUnits(scope, {
    grains: [...input.grains],
  });
  const covered = pointers.filter(
    (pointer) =>
      SUCCESS_STATUSES.has(pointer.status) &&
      pointer.publishedGenerationId !== null &&
      pointer.publishedGenerationId !== "",
  );
  if (covered.length === 0) {
    throw new InsufficientCoverageError(
      `google_ads: no covered units for grains ${input.grains.join(",")}`,
    );
  }
  const anchor =
    input.anchorDate ??
    covered
      .map((p) => p.date)
      .toSorted()
      .at(-1);
  if (!anchor) {
    throw new InsufficientCoverageError("google_ads: no anchor date");
  }
  const window = splitWindows(anchor, input.windowDays).current;
  const daysByGrain = new Map<string, Set<string>>();
  for (const grain of input.grains) daysByGrain.set(grain, new Set());
  for (const pointer of covered) {
    if (!inWindow(pointer.date, window)) continue;
    daysByGrain.get(pointer.grain)?.add(pointer.date);
  }
  let coverageRatio = 1;
  for (const grain of input.grains) {
    const days = daysByGrain.get(grain)?.size ?? 0;
    const ratio = days / input.windowDays;
    if (ratio < coverageRatio) coverageRatio = ratio;
    if (ratio < input.minCoverageRatio) {
      throw new InsufficientCoverageError(
        `google_ads: grain ${grain} covered ${days}/${input.windowDays} days ` +
          `(${ratio.toFixed(3)}) below ${input.minCoverageRatio}`,
      );
    }
  }
  const coveredUnitRefsByGrain = new Map<string, string[]>();
  for (const grain of input.grains) {
    const refs: string[] = [];
    for (const pointer of covered) {
      if (pointer.grain !== grain) continue;
      if (!inWindow(pointer.date, window)) continue;
      refs.push(`${connection.customerId}:${pointer.date}:${grain}`);
    }
    coveredUnitRefsByGrain.set(grain, refs.toSorted());
  }
  const snapshot = await GoogleAdsAnalyticsRepository.getAccountSnapshot(scope);
  const windowPointers = covered.filter((p) => inWindow(p.date, window));
  const metricDateBasis =
    windowPointers.map((p) => p.metricDateBasis).find((b) => b !== null) ??
    null;
  const fallbackCurrency = windowPointers
    .map((p) => p.currencyCode)
    .find((c) => c !== null);
  return {
    scope,
    customerId: connection.customerId,
    accountId: connection.id,
    currencyCode: snapshot?.currencyCode ?? fallbackCurrency ?? null,
    metricDateBasis,
    window,
    windowDays: input.windowDays,
    coverageRatio,
    coveredUnitRefsByGrain,
  };
}

/**
 * Sorted deduped `customerId:date:grain` unit refs for the requested grains;
 * the stored-evidence pointer set surfaced with each FindingDraft.
 */
export function googleAdsUnitRefs(
  coverage: GoogleAdsCoverageLoad,
  grains: readonly GoogleAdsGrain[],
): string[] {
  const refs = new Set<string>();
  for (const grain of grains) {
    for (const ref of coverage.coveredUnitRefsByGrain.get(grain) ?? []) {
      refs.add(ref);
    }
  }
  return [...refs].toSorted();
}
