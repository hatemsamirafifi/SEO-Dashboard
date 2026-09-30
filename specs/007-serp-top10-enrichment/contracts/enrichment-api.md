# Contract: SERP Competitive Enrichment API

**Feature**: `007-serp-top10-enrichment` | **Date**: 2026-09-30

Enrichment contract consumed by keyword-research SERP Analysis and the MCP twin. Base snapshot shape is frozen (spec 003); this contract is additive. See [research](research.md), [data model](data-model.md).

## `enrichCompetitiveMetrics`

- **Input**: `{ snapshot: SerpSnapshot, includeCompetitiveMetrics: boolean }` — enrichment runs only when explicitly requested (MCP flag defaults false; UI runs on the explicit analysis enrichment path, never on dashboard/report render).
- **Target selection**: Top-10 organic results only; canonicalize → dedupe → resolve. Position 11+ never enriched, never fetched.
- **Output**: base snapshot unchanged + per-target `CompetitiveMetrics` merged by normalized identity (never array position). Partial bulk responses merge present targets; absent targets render `unavailable`.
- **Invariants**:
  - Repeat within the 30-day target window → zero paid provider calls (cache hits, assertable via trace + billing spend).
  - Concurrent identical requests coalesce to exactly one paid fetch per uncached target.
  - Base results render identically with enrichment wholly failed (explicit per-row unavailable/failed states; zero recorded zeros).
  - Account-paused (40201) and credits-unavailable (40200) surface as distinct states; permanent failures are never blindly retried.
  - Metric names are provider-accurate only (DataForSEO Domain Rank / Page Rank, referring domains, backlinks, provider spam/risk, estimated traffic where returned) — proprietary third-party names banned by boundary test.
  - ETV is keyword-scoped snapshot data; it is never written to or read from the target cache.

## Cache contract

- Snapshot cache (short window, existing SERP TTL) and target-metric cache (30-day default via the single named policy constant, env-overridable per house TTL-registry pattern) are independent: fresh snapshot never blocks target refresh; stale targets never force a SERP refetch.
- Failed refresh preserves the previous value as stale with freshness/source metadata — never zeroed. Stale-served rows carry `stale: true` (last-known observation, not fresh) alongside their `failed` status; rows without any stale value render nulls.
- No proactive background refresh; refresh only on actual analysis need.
- Cache identity is target-oriented (normalized URL/domain + metric family + provider); keyword/market-specific metrics are never stored under the generic target cache.

## MCP surface

- `get_serp_results` gains `includeCompetitiveMetrics` (default false), thin-wrapped over the same service; paid-guard description updated. Untoggled calls return byte-identical responses to today.

## Trace contract

- Enrichment emits `serp_analysis` / `serp_competitive_enrichment` trace records (feature, operation, provider, cache status, status class, target counts, duration, cost metadata), secret-free, through the existing trace bridge. Trace is observability only.

## Stability promise

Field names, row-status vocabulary, and value semantics (0 vs — vs unavailable) are frozen for consumers (011, SAM); additive metric families only, no renames without versioning.
