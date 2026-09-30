import type { BillingCustomerContext } from "@/server/billing/subscription";
import { canonicalUrl } from "@/shared/intelligence";
import { SeoCacheService, getSeoDataRouter } from "@/server/lib/seo-data";
import {
  backlinksSummaryItemSchema,
  domainPageSummaryItemSchema,
} from "@/server/lib/dataforseo/backlinks-schemas";
import { z } from "zod";
import {
  enrichmentStatusOf,
  normalizedDomain,
  type CompetitiveMetrics,
  type EnrichmentTarget,
  type SerpEnrichmentStatus,
} from "./types";

/**
 * Bounded competitive enrichment for Top-10 SERP results (spec 007).
 *
 * Pipeline: canonicalize → dedupe → resolve → merge-by-identity (never
 * positional). Domain-level metrics (Domain Rank, totals, spam) come from
 * the backlinks summary leg, shared across same-domain URLs via the target
 * cache; Page Rank is URL-scoped and matched per row against the
 * domain-pages leg. Estimated traffic is keyword-scoped snapshot data and
 * never enters the target cache.
 *
 * Cost bounds: Top-10 only; one summary + one domain-pages router call per
 * deduped domain (cache-first, singleFlight-coalesced, budget-guarded by the
 * DataRouter); exactly one attempt per leg per run — permanent failures are
 * never blindly retried here. Repeat analyses inside the 30-day target
 * window complete with zero paid calls.
 */

export type SerpEnrichmentInput = {
  results: Array<{ position: number; url: string; domain: string }>;
  billingCustomer: BillingCustomerContext;
};

export type EnrichedCompetitorTarget = {
  target: EnrichmentTarget;
  metrics: CompetitiveMetrics;
};

export type SerpEnrichmentResult = {
  targets: EnrichedCompetitorTarget[];
  /** Run-level account block, distinct from per-row states. */
  accountBlocked: "account_paused" | "billing" | null;
};

export type SerpTraceOperation =
  | "serp_analysis"
  | "serp_competitive_enrichment";

export type EnrichmentTraceRecord = {
  operation: SerpTraceOperation;
  provider: string;
  targetCount: number;
  cacheHits: number;
  cacheMisses: number;
  statusCounts: Partial<Record<SerpEnrichmentStatus, number>>;
  durationMs: number;
  accountBlocked: "account_paused" | "billing" | null;
};

/**
 * Emit one structured trace line per enrichment operation (spec 007,
 * FR-009). Counts, enums, and durations only — secret-free by
 * construction. Follows the house `[prefix] k=v` log shape.
 */
export function traceEnrichmentRun(record: EnrichmentTraceRecord): void {
  const parts = [
    `op=${record.operation}`,
    `provider=${record.provider}`,
    `targets=${record.targetCount}`,
    `cacheHits=${record.cacheHits}`,
    `cacheMisses=${record.cacheMisses}`,
    ...Object.entries(record.statusCounts).map(
      ([status, count]) => `${status}=${count}`,
    ),
    `durationMs=${record.durationMs}`,
    `blocked=${record.accountBlocked ?? "none"}`,
  ];
  console.log(`[serp-enrichment] ${parts.join(" ")}`);
}

const domainPagesPayloadSchema = z.object({
  items: z.array(domainPageSummaryItemSchema).default([]),
});

type SummaryData = z.infer<typeof backlinksSummaryItemSchema>;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Classify a leg failure for the run-level account notice. */
function classifyAccountBlock(
  error: unknown,
): "account_paused" | "billing" | null {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const diagnostics =
    typeof error === "object" && error !== null
      ? (error as { diagnostics?: { dataforseoStatus?: unknown } }).diagnostics
      : undefined;
  const status = diagnostics?.dataforseoStatus;
  const message = error instanceof Error ? error.message : String(error);
  if (
    code === "DATAFORSEO_ACCESS_PAUSED" ||
    status === 40201 ||
    /40201/.test(message)
  ) {
    return "account_paused";
  }
  if (
    code === "CREDITS_UNAVAILABLE" ||
    status === 40200 ||
    status === 40210 ||
    /40200|40210/.test(message)
  ) {
    return "billing";
  }
  return null;
}

export async function enrichCompetitiveMetrics(
  input: SerpEnrichmentInput,
): Promise<SerpEnrichmentResult> {
  // Top-10 only: first 10 results in snapshot (position) order.
  const top = input.results.slice(0, 10);

  // Canonicalize → dedupe by normalized URL identity. Unparseable rows never
  // become targets (callers render them unavailable).
  const byIdentity = new Map<string, { positions: number[]; domain: string }>();
  for (const row of top) {
    const identity = canonicalUrl(row.url);
    if (identity === "(not set)") continue;
    const domain = normalizedDomain(row.url);
    if (!domain) continue;
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.positions.push(row.position);
    } else {
      byIdentity.set(identity, { positions: [row.position], domain });
    }
  }

  // Unique domains drive the paid legs (dedupe before any call).
  const domains = [...new Set([...byIdentity.values()].map((t) => t.domain))];
  const router = getSeoDataRouter();
  const startedAt = Date.now();
  let accountBlocked: SerpEnrichmentResult["accountBlocked"] = null;
  let cacheHits = 0;
  let cacheMisses = 0;

  const summaries = new Map<string, SummaryData | null>();
  const domainPages = new Map<
    string,
    Array<{ page: string; rank: number | null }>
  >();
  const failedDomains = new Set<string>();
  const staleDomains = new Set<string>();

  await Promise.all(
    domains.map(async (domain) => {
      const base = {
        dataType: "competitive_metrics" as const,
        domain,
        billingCustomer: input.billingCustomer,
        creditFeature: "backlinks",
      };
      const summaryRequest = {
        ...base,
        constraints: { backlinkCall: "summary" },
      };
      const pagesRequest = {
        ...base,
        constraints: { backlinkCall: "domain_pages" },
      };
      const [summarySettled, pagesSettled] = await Promise.allSettled([
        router.route<SummaryData>(summaryRequest, backlinksSummaryItemSchema),
        router.route(pagesRequest, domainPagesPayloadSchema),
      ]);
      if (summarySettled.status === "fulfilled") {
        if (summarySettled.value.fromCache) {
          cacheHits += 1;
        } else {
          cacheMisses += 1;
        }
        // Validate provider payloads at the trust boundary: a malformed
        // shape is an error path (failed), never silently treated as data.
        const parsed = backlinksSummaryItemSchema.safeParse(
          summarySettled.value.data,
        );
        if (parsed.success) {
          summaries.set(domain, parsed.data);
        } else {
          summaries.set(domain, null);
          failedDomains.add(domain);
        }
      } else {
        failedDomains.add(domain);
        accountBlocked =
          accountBlocked ?? classifyAccountBlock(summarySettled.reason);
        // Stale fallback (spec 007): serve the last-known value as stale
        // rather than nothing — never zeroed, always marked stale.
        const stale = await SeoCacheService.getStale<SummaryData>(
          summaryRequest,
          backlinksSummaryItemSchema,
        );
        if (stale) {
          summaries.set(domain, stale.data);
          staleDomains.add(domain);
        } else {
          summaries.set(domain, null);
        }
      }
      if (pagesSettled.status === "fulfilled") {
        if (pagesSettled.value.fromCache) {
          cacheHits += 1;
        } else {
          cacheMisses += 1;
        }
        const parsed = domainPagesPayloadSchema.safeParse(
          pagesSettled.value.data,
        );
        if (parsed.success) {
          domainPages.set(
            domain,
            parsed.data.items.map((item) => ({
              page: item.page ?? item.url ?? "",
              rank: item.rank ?? null,
            })),
          );
        } else {
          domainPages.set(domain, []);
          failedDomains.add(domain);
        }
      } else {
        domainPages.set(domain, []);
        failedDomains.add(domain);
        accountBlocked =
          accountBlocked ?? classifyAccountBlock(pagesSettled.reason);
        const stale = await SeoCacheService.getStale<
          z.infer<typeof domainPagesPayloadSchema>
        >(pagesRequest, domainPagesPayloadSchema);
        if (stale) {
          domainPages.set(
            domain,
            stale.data.items.map((item) => ({
              page: item.page ?? item.url ?? "",
              rank: item.rank ?? null,
            })),
          );
          staleDomains.add(domain);
        }
      }
    }),
  );

  const now = new Date().toISOString();
  const targets: EnrichedCompetitorTarget[] = [];
  // Note on metricFamily: every target resolves BOTH legs (summary for
  // Domain Rank/totals/spam, domain_pages for per-URL Page Rank); the field
  // records "summary" as the primary resolution leg. Router-level cache
  // identity distinguishes legs via backlinkCall constraints.
  for (const [identity, target] of byIdentity) {
    // Merge first (fresh or stale-staged values alike), then mark: a leg
    // error forces status "failed" but never discards staged values — stale
    // data stays visible as stale, missing data stays null, zero stays zero.
    const summary = summaries.get(target.domain) ?? null;
    // Page Rank is URL-scoped: match this row's identity against the
    // domain's page rows by normalized identity — never by array position.
    const pageRank =
      domainPages
        .get(target.domain)
        ?.find(
          (item) => item.page !== "" && canonicalUrl(item.page) === identity,
        )?.rank ?? null;
    const core = {
      domainRank: numberOrNull(summary?.rank),
      pageRank,
      referringDomains: numberOrNull(summary?.referring_domains),
      backlinks: numberOrNull(summary?.backlinks),
    };
    const status: SerpEnrichmentStatus = failedDomains.has(target.domain)
      ? "failed"
      : enrichmentStatusOf(core);
    targets.push({
      target: {
        identity,
        sourcePositions: target.positions,
        metricFamily: "summary",
      },
      metrics: {
        ...core,
        // Estimated traffic is keyword-scoped snapshot data (spec 007): it
        // flows from the SERP snapshot row, never from the target cache.
        estimatedTraffic: null,
        spamScore:
          numberOrNull(summary?.backlinks_spam_score) ??
          numberOrNull(summary?.info?.target_spam_score),
        status,
        provider: "dataforseo",
        // Backlinks endpoints serve live data (no provider snapshot date):
        // fetchedAt is the observation; providerSnapshotAt stays null.
        providerSnapshotAt: null,
        fetchedAt: now,
        stale: staleDomains.has(target.domain),
      },
    });
  }

  const statusCounts: Partial<Record<SerpEnrichmentStatus, number>> = {};
  for (const entry of targets) {
    const status = entry.metrics.status;
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  traceEnrichmentRun({
    operation: "serp_competitive_enrichment",
    provider: "dataforseo",
    targetCount: targets.length,
    cacheHits,
    cacheMisses,
    statusCounts,
    durationMs: Date.now() - startedAt,
    accountBlocked,
  });

  return { targets, accountBlocked };
}
