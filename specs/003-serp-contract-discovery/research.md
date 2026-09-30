# Research: SERP Contract Discovery and Freeze

**Feature**: `003-serp-contract-discovery` | **Date**: 2026-09-28

All unknowns resolved via spec clarification (2026-09-28) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: The actual SERP pipeline (verified in code)

### A. Two distinct SERP pipelines exist — do not conflate them

**Pipeline A — Rank-check pipeline (per-keyword, cached in tables, not R2):**
`createRankSerpResolver` (`src/server/features/serp/providerResolver.ts:140-220`) returns a resolver whose
`search()` (`src/server/features/serp/resolverCore.ts:153-316`) is built from three provider entries
(dataforseo `:169-184`, serper `:185-198`, zenserp `:199-213`). Consumers:

1. `RankCheckWorkflow` creates the resolver (`src/server/workflows/RankCheckWorkflow.ts:390-394`,
   client `:389`) and puts it on the check context (`:445-458`).
2. `checkBatchLive` invokes `ctx.rankSerp.search(normalizedInput)` (`src/server/workflows/rankCheckPaths.ts:282-283`).
3. Results persist as DB rows (provider-call diagnostics via
   `RankTrackingRepository.insertProviderCalls`, `src/server/features/rank-tracking/repositories/RankTrackingRepository.ts:255`;
   snapshots in rank tables). Provider-call diagnostics do NOT go to the trace bus for this pipeline.

**Pipeline B — Keyword research / MCP: DataRouter `dataType:"serp"` (cached, traced):**
- Keyword research routes `dataType:"serp"` → `getOrFetch` (`src/server/features/keywords/services/research/serp.ts:1-63`,
  routes `:46-52`; service export `KeywordResearchService.ts:4,16`; server function `src/serverFunctions/keywords.ts:123-135`).
- MCP `get_serp_results` (`src/server/mcp/tools/get-serp-results.ts:51-155`): routes the same way
  (`:102-108`), trims top 20, returns text tables + `structuredContent`.
- Router composition (`src/server/lib/seo-data/data-router.ts`): cache-first `getOrFetch` (`:110`) →
  `traceProviderCall` (`:134`) → `singleFlight(cacheKey, ...)` (`:135`) → provider; provider priority for
  `serp: ["internal", "dataforseo"]` (`:49`) — internal declines, so **DataForSEO is the only live
  router-backed SERP provider**; `serper`/`zenserp` adapters exist in `httpProviders.ts:215-379` but are
  wired ONLY into the rank-check resolver (pipeline A), not the DataRouter.
- DataForSEO route: `dataforseo-provider.ts:465-477` → `client.serp.live({ keyword, locationCode, languageCode })`
  (`src/server/lib/dataforseo/serp.ts:84-108`, depth 100 desktop, `SerpLiveItem` schema `:49-82`).
- Cache: key `${"seo:" + dataType}:` + sha256 of sorted params — keyword, locationCode, languageCode,
  device, dateFrom/dateTo, constraints, organizationId (`src/server/lib/seo-data/cache-service.ts:22-59`;
  primitive `src/server/lib/r2-cache.ts:20-29`, R2 prefix `dataforseo-cache/`). TTL `serp: 5 days`
  (`src/server/lib/seo-data/config.ts:14`, env override `SEO_CACHE_TTL_SERP` `:28,46-54`).
- Cost: router `recordFreeProviderCall` (`data-router.ts:138-140`); metered client
  `meterDataforseoCall` (`src/server/lib/dataforseo/client.ts:144-235`): budget assert `:182`,
  spend record `:185`, hosted credits `:197`, `trackUsageCreditSpend`
  (`src/server/billing/subscription.ts:202-260`); rank-check meters `rank_tracking`
  (`src/server/lib/dataforseo/client.ts:104-116`); MCP local SERP uses the direct budget guard
  (`src/server/mcp/tools/dataforseo-research-tools.ts:37-42,779`).
- Trace: `traceProviderCall` (`src/server/lib/seo-data/trace.ts:28-72`, no-op outside a SAM turn) and
  `traceCacheDecision` (`:79-90`), invoked from `data-router.ts:134,198,201`. Rank-check persists
  provider-call diagnostics as rows (`rankCheckPaths.ts:337-345,384-393`), not trace events.

### B. Resolution order and retry semantics (pipeline A)

- Entries sorted by priority (`resolverCore.ts:151`); per-provider retries run to exhaustion before
  failover (`:198-303`); cancellation checked before every dispatch/wait; deterministic failures skip
  remaining retries (`:280`); circuit breaker opens only on deterministic failures (`:307-313`).
- Serper deliberately declines `device: "mobile"` (`httpProviders.ts:223` + comment `:221-222`).
- Failover ends in `SerpProvidersUnavailableError` carrying per-provider diagnostics
  (`resolverCore.ts:315`, class `:25-49`).

### C. Normalization points — ground truth

- **Pipeline A (rank check)**: `httpProviders.ts` normalizes Serper/Zenserp per page via
  `normalizeOrganic` (`:174-192`) with absolute-position math (`:162-165`); the DataForSEO adapter keeps
  `client.serp.rankCheck`'s shape and nulls `title` (`providerResolver.ts:70-137`),
  `fetchRankCheckSerp` (`src/server/lib/dataforseo/serp.ts:143-182`) deriving `serpFeatures` as
  **unique `item.type` strings** (`serp.ts:139`) — the single existing features signal.
- **Pipeline B (router)**: `SerpLiveItem` items map to `SerpResultItem`
  (`src/types/keywords.ts:53-65`) in `mapOrganicSerpItems` (`serp.ts` keywords feature, `:15-31`).
  MCP returns `{type, rank, title, url, domain, description}` (`get-serp-results.ts:111-118`).
- **Feature parsing truth**: No PAA/featured-snippet/local-pack/knowledge-graph CONTENT parsing exists
  anywhere. Only feature-type *strings* flow today (`serpFeatures` in rank results;
  `RankTrackingTableParts.tsx:13-55` renders those label strings). The 011 package therefore consumes a
  contract designed ahead of provider parsing — providers currently return family names at best.

### D. Docs-vs-code discrepancies (code authoritative — T005)

1. **"SERP providers" are resolver-only in practice.** `serper`/`zenserp` adapters exist and are fully
   functional (`httpProviders.ts:215-379`) but are reachable only through the rank-check resolver;
   keyword research/MCP SERP always resolves through DataForSEO (router).
2. **Device is a rank-check-only dimension on the router path.** `device` is hashed into
   `seo:serp` cache keys (`cache-service.ts:43-57`) but never set by the router serp request
   (`dataforseo-provider.ts:465-477`); `client.serp.live` sends no device. Rank check passes device
   through (`providerResolver.ts:83`).
3. **Serper device support**: prior docs assumed device support; code documents Serper as
   desktop-only-by-design (`httpProviders.ts:221-223`).
4. **`get_serp_results` does NOT go through `createRankSerpResolver`** (docs implied resolver usage);
   it routes through the DataRouter (`get-serp-results.ts:102-108`).
5. **Feature blocks are not parsed anywhere yet** — earlier plan docs implied features existed; the
   only feature signal is type strings (`serp.ts:139`). The frozen contract below is the design target
   all future parsing must map into; no parsing code changes in this package.

### T003 walkthrough log (zero-corrections dry run)

Traced "seo dashboard" (`keywordId` `kw-1`, depth 10, desktop, US/en) pipeline A end-to-end using only
the references above — entry `RankCheckWorkflow` → `checkBatchLive` → resolver `search` →
dataforseo adapter → `fetchRankCheckSerp` → `buildRankCheckResult` → snapshot/insertProviderCalls. All
references resolved to real symbols/files; zero discrepancies found during the trace itself (discrepancies
were doc-vs-code, §D). Report is code-authoritative.

## Decision 1: Discovery scope (verified entry points)

- **Decision**: Two verified SERP pipelines: rank-check resolver (pipeline A) and DataRouter
  `dataType:"serp"` (pipeline B: keyword research + MCP). The frozen contract spans both: every
  normalized snapshot produced by either pipeline conforms to one `SerpSnapshot` model.
- **Rationale**: File inventory verified in repo (`src/server/features/serp/`); code is authoritative over
  prior docs where they disagree.
- **Alternatives considered**: Trusting prior plan docs (rejected: docs-vs-code disagreements already known).

## Decision 2: Logical snapshot identity

- **Decision**: (keyword, engine, canonical location, language, device, checkedAt-full-ISO); provider is
  provenance, not identity; content hash optional for integrity only; projectId is storage tenancy, not
  observation semantics.
- **Rationale**: Clarified 2026-09-28; prevents duplicate provider-specific models and same-day collisions;
  gives 007 a deterministic cache/merge key.
- **Alternatives considered**: Provider-in-identity (rejected: same SERP stored 3x); calendar-date identity
  (rejected: same-day rechecks collide); content-hash identity (rejected: identical payloads from different
  contexts merge incorrectly).

## Decision 3: Metric vocabulary

- **Decision**: DataForSEO Domain Rank / Page Rank, referring domains, backlinks, provider-supported
  spam/risk, estimated traffic only where genuinely available. No DA/PA/DR/TF/CF.
- **Rationale**: Constitutional P16; provider docs are the vocabulary authority.
- **Alternatives considered**: Familiar third-party labels (rejected: fabrication).

## Decision 4: No-migration enrichment cache (forward reference for 007)

- **Decision**: MVP enrichment reuses existing R2/`SeoCacheService` patterns (SERP snapshot vs target-metric
  freshness families); no DB migration in this contract.
- **Rationale**: Source-plan S6 rule; keeps 003/007 schema-free.
- **Alternatives considered**: Persisting snapshots relationally now (rejected: history storage is Later-list).
