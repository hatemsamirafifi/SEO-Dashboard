// Spec 014 (G5/P36) — competitor-gap input spike harness.
//
// Time-boxed measurement over the approved provider set (P6) measuring the
// five dimensions from research R3 against a pre-registered manifest:
//   1. quality   — competitor keyword coverage + required-field missing rate
//   2. coverage  — first-party (GSC/rank) coverage for the same window
//   3. cost      — measured credits per analysis (budget-capped)
//   4. identity  — canonical identity stability via the §006 chain
//   5. cache     — repeat-analysis paid calls + cache hit rate
//
// Invariants:
// - P8/P9: a failed measurement marks its dimension `unavailable` — never 0.
// - P12: the manifest's budgetCapCredits hard-bounds paid work; refusal is
//   explicit, never a silent empty run.
// - P11: all provider resolution goes through the seo-data router
//   (cache-first, internal→dataforseo) — no direct provider calls here.
// - Detectors never run here; the spike measures INPUTS, it detects nothing.

import { getCostCounters } from "@/server/lib/seo-data/cost-tracker";
import { getSeoDataRouter } from "@/server/lib/seo-data/registry";
import { canonicalUrl } from "@/shared/intelligence";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  evaluateVerdict,
  recordVerdict,
} from "@/server/lib/competitor-gap/verdictLedger";
import {
  manifestMeta,
  traceSpikeEvent,
} from "@/server/lib/competitor-gap/trace";
import type {
  CompetitorGapSpikeEvidence,
  CompetitorGapSpikeManifest,
  CompetitorGapVerdictRow,
  SpikeDimensionResult,
} from "@/shared/competitorGap";

/** Provider-facing description of one competitor row we expect to measure. */
type CompetitorRow = {
  domain?: unknown;
  visibility?: unknown;
  keywordCount?: unknown;
  relevance?: unknown;
};

/** Thrown when the manifest's budget cap would be exceeded before/during work. */
export class SpikeBudgetExceededError extends Error {
  constructor(
    readonly budgetCapCredits: number,
    readonly projectedCredits: number,
  ) {
    super(
      `SPIKE_BUDGET_EXCEEDED: projected ${projectedCredits} credits exceed the manifest cap of ${budgetCapCredits}`,
    );
    this.name = "SpikeBudgetExceededError";
  }
}

export type SpikeHarnessDeps = {
  /** Router resolution for competitor rows (cache-first by construction). */
  fetchCompetitors: (domain: string) => Promise<unknown[]>;
  /** First-party coverage ratio for the window, or throws on failure. */
  fetchFirstPartyCoverageRatio: () => Promise<number>;
  /** Credits consumed per one competitor-set analysis (paid call counter). */
  measureCredits: () => number;
  /** Now — injected for determinism in tests. */
  now: () => Date;
};

/** Production deps: router + stored GSC coverage reads + cost counters. */
export function defaultSpikeDeps(
  manifest: CompetitorGapSpikeManifest,
  billing: BillingCustomerContext,
): SpikeHarnessDeps {
  return {
    fetchCompetitors: async (domain: string) => {
      const router = getSeoDataRouter();
      const response = await router.route({
        dataType: "domain_keywords",
        domain,
        locationCode: manifest.market.locationCode,
        languageCode: manifest.market.languageCode,
        billingCustomer: billing,
        creditFeature: "competitor_gap_spike",
      });
      return Array.isArray(response.data) ? (response.data as unknown[]) : [];
    },
    // First-party coverage: stored GSC summary-grain coverage over the
    // measurement window (stored reads only — G10). A ratio of covered days
    // in the window; projects with no GSC coverage return 0, which is a
    // MEASURED zero (valid, distinct from unavailable).
    fetchFirstPartyCoverageRatio: async () => {
      const to = new Date();
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - 28);
      const range = await GscSearchPerformanceRepository.getStoredCoverageRange(
        manifest.projectId,
      );
      if (!range) return 0;
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      if (!range.endDate || range.endDate < fromStr) return 0;
      const coveredStart =
        range.startDate > fromStr ? range.startDate : fromStr;
      const coveredEnd = range.endDate < toStr ? range.endDate : toStr;
      const dayCount =
        (Date.parse(`${coveredEnd}T00:00:00Z`) -
          Date.parse(`${coveredStart}T00:00:00Z`)) /
        (24 * 60 * 60 * 1000);
      return Math.max(0, Math.min(1, dayCount / 28));
    },
    measureCredits: () => getCostCounters().estimatedDataforseoCostUsd,
    now: () => new Date(),
  };
}

/** Wrap one measurement: failure → `unavailable` with reason, never a fake 0. */
async function measure<T>(
  operation: () => Promise<T>,
): Promise<SpikeDimensionResult<T>> {
  try {
    return { status: "measured", value: await operation() };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute the spike: run all five dimensions against the manifest, evaluate
 * the verdict deterministically, and append it to the ledger. Returns the
 * persisted row (frozen evidence + verdict).
 */
export async function runSpike(input: {
  manifest: CompetitorGapSpikeManifest;
  billing: BillingCustomerContext;
  deps?: Partial<SpikeHarnessDeps>;
}): Promise<CompetitorGapVerdictRow> {
  const deps: SpikeHarnessDeps = {
    ...defaultSpikeDeps(input.manifest, input.billing),
    ...input.deps,
  };
  const startedAt = Date.now();
  traceSpikeEvent({
    operation: "competitor_gap_spike_measure",
    ...manifestMeta(input.manifest),
  });

  // Budget pre-check (P12): refuse to start when the projected spend exceeds
  // the manifest cap. Explicit refusal, never a silent empty run.
  const projectedCredits = projectSpendCredits(input.manifest);
  if (projectedCredits > input.manifest.budgetCapCredits) {
    traceSpikeEvent({
      operation: "competitor_gap_spike_measure",
      ...manifestMeta(input.manifest),
      durationMs: Date.now() - startedAt,
      error: `SPIKE_BUDGET_EXCEEDED projected=${projectedCredits} cap=${input.manifest.budgetCapCredits}`,
    });
    throw new SpikeBudgetExceededError(
      input.manifest.budgetCapCredits,
      projectedCredits,
    );
  }

  // Dimension 1 — quality: competitor keyword coverage + field-missing rate.
  const quality = await measure(async () => {
    const rowsPerDomain: CompetitorRow[][] = [];
    for (const domain of input.manifest.sampleDomains) {
      const rows = await deps.fetchCompetitors(domain);
      rowsPerDomain.push(rows.map(coerceCompetitorRow));
    }
    const requiredFields: (keyof CompetitorRow)[] = ["domain"];
    let rowsTotal = 0;
    let missingFields = 0;
    let rowsWithDomain = 0;
    for (const rows of rowsPerDomain) {
      for (const row of rows) {
        rowsTotal += 1;
        for (const field of requiredFields) {
          if (row[field] === undefined || row[field] === null) {
            missingFields += 1;
          }
        }
        if (typeof row.domain === "string" && row.domain !== "") {
          rowsWithDomain += 1;
        }
      }
    }
    // Successful zero-row analyses are valid 0-ratio measurements (P9) —
    // distinct from the fetchCompetitors failure path, which throws above.
    const keywordCoverageRatio =
      rowsTotal === 0 ? 0 : rowsWithDomain / rowsTotal;
    const requiredFieldMissingRate =
      rowsTotal === 0 ? 0 : missingFields / rowsTotal;
    return { keywordCoverageRatio, requiredFieldMissingRate };
  });

  // Dimension 2 — coverage: first-party window coverage for the same set.
  const windowEnd = deps.now();
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - 28);
  const coverage = await measure(async () => ({
    firstPartyCoverageRatio: await deps.fetchFirstPartyCoverageRatio(),
    window: {
      from: windowStart.toISOString().slice(0, 10),
      to: windowEnd.toISOString().slice(0, 10),
    },
  }));

  // Dimension 3 — cost: measured credits per analysis (already bounded by
  // the pre-check + router budget guards).
  const cost = await measure(async () => {
    const measuredCreditsPerAnalysis = deps.measureCredits();
    const extrapolatedMonthlyPerProject = measuredCreditsPerAnalysis * 4;
    return { measuredCreditsPerAnalysis, extrapolatedMonthlyPerProject };
  });

  // Dimension 4 — identity: canonical identity stability via the §006 chain.
  // Two distinct failure modes:
  //  - COLLISION: two DIFFERENT sampled domains map to the same identity
  //    (cross-domain identity loss — hard BLOCKED input).
  //  - NON-DETERMINISM: the same input maps to different identities on
  //    repeated canonicalization (must never happen).
  // Normalization within one domain (trailing slash, case, query strings)
  // collapsing to one identity is EXPECTED §006 behavior and is not counted.
  const identity = await measure(async () => {
    const identityByDomain = new Map<string, Set<string>>();
    let nonDeterministicMappings = 0;
    for (const domain of input.manifest.sampleDomains) {
      const identities = new Set<string>();
      for (const raw of identityVariants(domain)) {
        const first = canonicalUrl(raw);
        const second = canonicalUrl(raw);
        if (first !== second) nonDeterministicMappings += 1;
        identities.add(first);
      }
      for (const canonicalIdentity of identities) {
        const owners =
          identityByDomain.get(canonicalIdentity) ?? new Set<string>();
        owners.add(domain);
        identityByDomain.set(canonicalIdentity, owners);
      }
    }
    let collisionsObserved = 0;
    for (const owners of identityByDomain.values()) {
      if (owners.size > 1) collisionsObserved += owners.size - 1;
    }
    return { collisionsObserved, nonDeterministicMappings };
  });

  // Dimension 5 — cache: repeat the competitor analysis for the first
  // sampled domain; the second pass must be served without paid calls.
  const cache = await measure(async () => {
    const before = deps.measureCredits();
    await deps.fetchCompetitors(input.manifest.sampleDomains[0] ?? "");
    const after = deps.measureCredits();
    const repeatAnalysisPaidCalls = Math.max(0, after - before > 0 ? 1 : 0);
    const repeatCacheHitRate = repeatAnalysisPaidCalls === 0 ? 1 : 0;
    return { repeatAnalysisPaidCalls, repeatCacheHitRate };
  });

  const evidence: CompetitorGapSpikeEvidence = {
    quality,
    coverage,
    cost,
    identity,
    cache,
  };

  const row = await recordVerdict({
    evidence,
    thresholds: input.manifest.thresholds,
    manifest: input.manifest,
    recordedAt: deps.now().toISOString(),
  });

  traceSpikeEvent({
    operation: "competitor_gap_verdict_record",
    ...manifestMeta(input.manifest),
    verdict: row.verdict,
    dimensionStatuses: {
      quality: quality.status,
      coverage: coverage.status,
      cost: cost.status,
      identity: identity.status,
      cache: cache.status,
    },
    durationMs: Date.now() - startedAt,
    measuredCreditsPerAnalysis:
      cost.status === "measured"
        ? cost.value.measuredCreditsPerAnalysis
        : "unavailable",
  });

  return row;
}

/**
 * Projected spend for the manifest (P12 pre-check): one competitors fetch per
 * sampled domain plus one repeat for the cache dimension. The projection is
 * deliberately conservative — if the projection alone exceeds the cap, the
 * spike refuses to start rather than partially spending.
 */
function projectSpendCredits(manifest: CompetitorGapSpikeManifest): number {
  const perFetchCredits = 1;
  const fetchCount = manifest.sampleDomains.length * 2;
  return fetchCount * perFetchCredits;
}

/** Raw URL/domain variants for one domain — identity-stability probes that
 *  MUST all canonicalize deterministically (per §006: scheme/case/trailing
 *  slash collapse; www is a distinct host by design). */
function identityVariants(domain: string): string[] {
  return [
    `https://${domain}/`,
    `https://${domain}`,
    `HTTPS://${domain.toUpperCase()}/`,
    `https://www.${domain}/`,
    `https://${domain}/path`,
    `https://${domain}/path?utm_source=x`,
  ];
}

/** Narrow an unknown router row to the fields the spike measures. */
function coerceCompetitorRow(row: unknown): CompetitorRow {
  if (row === null || typeof row !== "object") return {};
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural probe of router payload; fields validated below
  return row as CompetitorRow;
}

export { evaluateVerdict };
