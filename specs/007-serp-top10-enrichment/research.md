# Research: SERP Top-10 Competitive Enrichment

**Feature**: `007-serp-top10-enrichment` | **Date**: 2026-09-30

All unknowns resolved via spec clarifications (2026-09-30) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Enrichment service home and call path

- **Decision**: New enrichment service lives in the SERP feature (`src/server/features/serp/`, next to the frozen `SerpSnapshot` contract in `types.ts`), called by keyword research's `getSerpAnalysis` (`serp.ts:33-61`) AFTER the snapshot resolves, behind the opt-in flag. MCP `get_serp_results` (`get-serp-results.ts:96-119`, currently trimming top 20 at `:111`) thin-wraps the same service. 011 and SAM reuse it later.
- **Rationale**: Verified call path — `getSerpAnalysis` already routes `dataType:"serp"` through the DataRouter and maps organic items (`serp.ts:15-31`); the SERP feature owns the normalized model (P14) and the identity keys enrichment merges by. One service, three callers (P1/P2).
- **Alternatives considered**: Enrichment logic inside keyword research (rejected: duplicates the model away from the SERP feature; 011 couldn't reuse it); enrichment inside the resolver (rejected: resolver is per-keyword fetch, enrichment is per-target cached metrics — different cache identity).

## Decision 2: Metric source mapping (verified in repo)

- **Decision**: Domain Rank ← backlinks summary `rank` (`backlinks-schemas.ts:14`); Page Rank ← domain-pages summary `rank` per page URL (`domainPageSummaryItemSchema:80`) looked up per deduped URL; referring domains/backlinks ← summary totals (`backlinks-schemas.ts:15-17`); spam/risk ← `backlinks_spam_score` / `target_spam_score` where present (`:26-31`); estimated traffic ← embedded SERP-live `etv` (`serp.ts:59`) ONLY — ETV is keyword-scoped and never enters the target cache.
- **Rationale**: All sources already exist in-repo via `fetchBacklinksSummary` / `fetchDomainPagesSummary` (`backlinks.ts:104,202`) — no new endpoints, no new provider. SERP-live items already embed `backlinks_info` + `etv` per organic result (`serp.ts:46-70`), so the base snapshot carries partial metrics free; enrichment fills Domain/Page Rank from the per-target calls.
- **Alternatives considered**: Labs `fetchDomainRankOverview`/`fetchRankedKeywords` (`labs.ts:180,205`) as primary rank source (kept as corroborating fallback only — unneeded second fetch when summary/domain-pages already answer); cross-provider rank fill (rejected: new coupling, violates bounded design + clarified rule).

## Decision 3: Bounded calls without a true bulk endpoint

- **Decision**: No bulk backlinks-summary endpoint is confirmed anywhere in the approved provider set, so per-target single calls bounded by Top-10 (≤10/run, deduped before any call) + cache + singleFlight coalescing IS the G8-compliant design ("no N+1 when a bulk endpoint exists" — none exists here).
- **Rationale**: DataForSEO backlinks/rank surfaces in-repo are all single-target live calls; inventing "bulk" where none exists would fabricate an integration. The bound (Top-10 × dedupe × cache × coalesce × budget assert) is the enforceable guarantee, asserted by SC-002/SC-004 tests.
- **Alternatives considered**: Labs bulk traffic estimation endpoint (rejected: ETV is optional and keyword-scoped anyway; unverified endpoint adds a second Labs dependency for zero core-metric gain).

## Decision 4: Cache reuse via the DataRouter

- **Decision**: Route enrichment target fetches through the existing DataRouter (`data-router.ts:84-159`): cache-first `SeoCacheService.getOrFetch` + `singleFlight(cacheKey)` (`:135`) + `traceProviderCall` (`:134`) + metered client budget assert (`client.ts:182`) come free. New centralized TTL registry entry (house `config.ts` pattern: `DEFAULT_TTL_SECONDS` + `SEO_CACHE_TTL_*` env override) for target metrics at the binding 30-day default (2,592,000s), keyed by the single named policy constant. Target cache identity = normalized target + metric family + provider (never keyword) — matches the router's per-params cache-key derivation (003 research: `seo:{dataType}:` + sha256 of sorted params).
- **Rationale**: Verified to exist and already satisfy every FR-006 behavior (zero-repeat-paid, coalescing, budget). Reuse, not reinvention (P2/P11-P13).
- **Alternatives considered**: Standalone target cache bypassing the router (rejected: would need to reimplement singleFlight, TTL registry, trace, and budget — all present in the router path).

## Decision 5: Error semantics reuse

- **Decision**: Enrichment consumes the existing deterministic classification — `envelope.ts` (`isDataforseoAccountPaused:196`, `defaultClassifyDataforseoTask:223-228` → `DATAFORSEO_ACCESS_PAUSED` vs `CREDITS_UNAVAILABLE`), billing classification (`dataforseoBillingClassification.ts`: 40200/40210 billed, 40201 never billed), and the diagnostics parser. No new classification code; permanent failures are never blindly retried (existing retry/circuit-breaker policy objects reused).
- **Rationale**: Verified: the entire 40201-vs-40200 machinery already exists with tests (`envelope.test.ts`, keyword-research 40201 UI tests). FR-008 is a consumption requirement, not new code.
- **Alternatives considered**: Enrichment-local error mapping (rejected: would fork classification — P10 forbids).

## Decision 6: Trace and UI landing spots

- **Decision**: Trace events extend the existing taxonomy incrementally (`serp_analysis` / `serp_competitive_enrichment`) through the router bridge (`trace.ts:28-90`, SAM-bus no-op outside turns) plus the keyword-research trace diagnostics the panel already renders (`keywordResearchTraceHelper.ts`, 40201 error-card tests in `keywordResearchErrors.test.ts`). UI: `SerpAnalysisCard` → `SerpAnalysisTable(items: SerpResultItem[])` (`SerpAnalysisCard.tsx:5-69`) gains the expanded competitor row with 0/—/unavailable states; base panel render path unchanged (failure degrades the enrichment section only).
- **Rationale**: Verified surfaces; failure UI already has a proven pattern (40201 access-paused card). Trace stays observability-only (P42).
- **Alternatives considered**: New parallel trace vocabulary (rejected: P41/P42 layering; the bridge + existing taxonomy cover it).

## Decision 7: Test matrix landing spots

- **Decision**: Selection/merge/value-semantics → new enrichment service test + `serpSnapshot.test.ts` fixture extension; metric vocabulary (no DA/PA/DR/TF/CF) → `serpBoundaries.test.ts` extension; errors → classification tests + keyword-research error-card tests; UI states → SerpAnalysis row/error tests; cache/TTL/coalesce → cache-service + router-behavior tests; MCP flag → `get-serp-results` tool tests.
- **Rationale**: Mirrors the mandatory matrix cell-by-cell onto existing suites; matches colocated-Vitest convention.
- **Alternatives considered**: One integration-only suite (rejected: the matrix explicitly demands unit-level value-semantics and error cells).

## Decision 8: Stale fallback mechanics (discovered during implementation)

- **Decision**: Failed refreshes fall back to stale values via a new `getStaleCached` R2 primitive (ignores soft expiry) + `SeoCacheService.getStale` (same key derivation + schema validation), consumed per-leg inside the enrichment service only. Served stale values carry `stale: true` with `failed` status; rows without stale data render nulls. The router's generic path is untouched.
- **Rationale**: Verified in code — R2 TTLs here are soft `customMetadata` (`r2-cache.ts:36-64`): expired objects persist, so stale reads need no schema change and no second write path. Service-level (not router-level) fallback keeps the failure semantics of every other data type byte-identical (P50).
- **Alternatives considered**: Router-generic stale fallback (rejected: would change failure semantics for all data types); dropping stale fallback as "unsupported" (rejected: the binding clarification requires previous-value preservation, and the mechanism exists).
