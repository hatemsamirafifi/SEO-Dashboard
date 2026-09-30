# Data Model: SERP Top-10 Competitive Enrichment

**Feature**: `007-serp-top10-enrichment` | **Date**: 2026-09-30

No new persisted tables. Models below are service/cache contracts; the base SERP snapshot shape is frozen (spec 003) and extended additively only.

## EnrichmentTarget

One deduplicated Top-10 result target sent for metric resolution, keyed by
normalized URL identity (canonical page identity — 006). Same-URL duplicate
rows share one entry; different URLs on one domain are distinct targets
(Page Rank is URL-scoped and must never be shared across a domain).
Domain-level fetches (summary) dedupe by normalized domain behind the
shared target cache, so same-domain URLs cost one paid summary.

| Field           | Type     | Rules                                                                                    |
| --------------- | -------- | ---------------------------------------------------------------------------------------- |
| identity        | string   | Normalized URL identity (canonicalize first; same-URL duplicates collapse to one target) |
| sourcePositions | number[] | Snapshot positions this target backs (positional display only — never merge identity)    |
| metricFamily    | enum     | Which metric family is requested for this target                                         |

## CompetitiveMetrics

Per-target metric set with explicit availability (extends the 003 snapshot additively; never rewrites it).

| Field            | Type           | Rules                                                                                                                         |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| domainRank       | number \| null | DataForSEO Domain Rank; null = missing (renders "—"), never 0-substituted                                                     |
| pageRank         | number \| null | DataForSEO Page Rank per URL; same null semantics                                                                             |
| referringDomains | number \| null | Same null semantics; explicit provider 0 renders 0                                                                            |
| backlinks        | number \| null | Same null semantics; explicit provider 0 renders 0                                                                            |
| estimatedTraffic | number \| null | Optional; present only where the provider returned it; ETV from snapshots is keyword-scoped and never stored here             |
| spamScore        | number \| null | Optional provider-supported spam/risk; absent → unavailable                                                                   |
| status           | enum           | available \| partial \| unavailable \| failed — derived from core-metric presence only (optional metrics never decide status) |
| provenance       | object         | Provider + providerSnapshotAt + fetchedAt per metric family (P19: snapshot time ≠ fetch time)                                 |

**Validation**: `status == available ⟺ all core metrics non-null`; provider-accurate names only (boundary-tested vocabulary).

## TargetMetricCacheEntry

| Field          | Type               | Rules                                                                                                  |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| key            | string             | Normalized target identity + metric family + provider (reusable across keywords; never keyword-scoped) |
| metrics        | CompetitiveMetrics | Cached value; explicit zeros preserved as zeros                                                        |
| fetchedAt      | string             | Fetch time; freshness = now − fetchedAt vs the 30-day named policy constant                            |
| staleOnFailure | boolean            | A failed refresh keeps the previous value visible as stale with freshness metadata — never zeroed      |

## RowStatus transitions

Per enriched row: `available` (all core present) | `partial` (some core missing) | `unavailable` (no usable enrichment) | `failed` (provider request/error path failed). Computed per render from cached/requested state; no transitions persist.

## Relationships

`SerpSnapshot 1—* EnrichmentTarget` (Top-10 slice, duplicates shared); `EnrichmentTarget 1—1 CompetitiveMetrics`; `TargetMetricCacheEntry` keyed independently of any snapshot. 011 consumes the same snapshot + metrics for SERP-feature UI later.
