# Tasks: SERP Top-10 Competitive Enrichment

**Input**: Design documents from `/specs/007-serp-top10-enrichment/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/enrichment-api.md; frozen 003 contract `specs/003-serp-contract-discovery/contracts/serp-snapshot.md`

**Tests**: Included — Constitution P43–P45 + spec SC-004 mandate the full test matrix (selection/bulk/merge/value-semantics/errors/UI/cache).

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline verification before extending the SERP surface

- [x] T001 Verify baseline green: run `pnpm test serpSnapshot && pnpm test serpBoundaries && pnpm test keywordResearchErrors` plus `pnpm types:check` before changes; re-read the frozen 003 contract (mandatory input)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The additive metrics contract + centralized TTL policy all stories consume

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 Extend `src/server/features/serp/types.ts` additively with `CompetitiveMetrics` (core: `domainRank`, `pageRank`, `referringDomains`, `backlinks`; optional: `estimatedTraffic`, `spamScore` — all nullable, explicit zeros valid; `status: available | partial | unavailable | failed` derived ONLY from core presence; `provenance` per metric family with provider + `providerSnapshotAt` + `fetchedAt`) and `EnrichmentTarget` (normalized identity + backed positions + metric family) per `contracts/enrichment-api.md`; base `serpSnapshotSchema` shape unchanged
- [x] T003 [P] Add the named policy constant + TTL registry entry in `src/server/lib/seo-data/config.ts`: target competitive metrics default 30 days (2,592,000s) with `SEO_CACHE_TTL_*` env override per the house pattern — one centralized constant, no scattered day-count checks
- [x] T004 [P] Write contract tests for the metric/value semantics in `src/server/features/serp/serpSnapshot.test.ts`: status derivation (all core present → available; core missing → partial; nothing usable → unavailable; request error → failed — optional metrics never decide status), explicit-zero-renders-zero vs missing-renders-unavailable, ETV is keyword-scoped and never in target metrics

**Checkpoint**: Foundation ready — contract types + TTL policy green; user stories can begin in parallel

---

## Phase 3: User Story 1 - See competitive strength of the Top-10 (Priority: P1) ⭐ MVP

**Goal**: The enrichment pipeline resolves metrics for exactly the Top-10, merged by identity, with correct value semantics

**Independent Test**: Run enrichment over a fixture snapshot with 10+ results; Top-10 rows carry core metrics or explicit unavailable; position 11+ un-enriched with zero fetches; 100% identity-based merges

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T005 [P] [US1] Selection/merge tests in a new `src/server/features/serp/serpEnrichment.test.ts`: Top-10 slice only (11+ never fetched), canonicalize→dedupe (same domain twice → one target, both rows served), merge-by-identity (partial bulk responses match per normalized identity, never array position; unmatched → unavailable), <10 results → all present results enrichable
- [x] T006 [P] [US1] Error-classification tests in `src/server/features/serp/serpEnrichment.test.ts`: total failure → explicit failed state, base snapshot untouched; account-paused (40201) vs credits-unavailable (40200) distinct states; permanent failures never blindly retried (reuse existing envelope/billing classification — `envelope.ts:196,223-228`, `dataforseoBillingClassification.ts`)

### Implementation for User Story 1

- [x] T007 [US1] Implement the enrichment service in `src/server/features/serp/serpEnrichment.ts` (new): canonicalize → dedupe targets → resolve metrics (Domain Rank ← backlinks summary `rank`, Page Rank ← domain-pages `rank` per URL, referring domains/backlinks ← summary totals, spam ← `backlinks_spam_score`/`target_spam_score` where present — reusing `fetchBacklinksSummary`/`fetchDomainPagesSummary` in `src/server/lib/dataforseo/backlinks.ts` via the DataRouter so cache/singleFlight/trace/budget come free) → merge by identity; ≤10 deduped calls per run, never keyword-scoped cache keys
- [x] T008 [US1] Wire keyword research: `getSerpAnalysis` in `src/server/features/keywords/services/research/serp.ts` calls the enrichment service after the snapshot resolves, behind the opt-in flag; snapshot result unchanged when flag off; enrichment failure never blocks the snapshot return
- [x] T009 [US1] Render the expanded competitor row with value semantics (0 / — / unavailable) in `src/client/features/keywords/components/SerpAnalysisCard.tsx` (extend `SerpAnalysisTable`; provider-accurate metric names only — DataForSEO Domain Rank / Page Rank, referring domains, backlinks)

**Checkpoint**: US1 independently testable — enriched Top-10 panel over the frozen contract

---

## Phase 4: User Story 2 - Repeat and concurrent enrichment cost nothing extra (Priority: P2)

**Goal**: Cache windows + coalescing guarantee zero extra paid calls on repeats and concurrent runs

**Independent Test**: Repeat the same analysis within TTL (zero paid calls), fire two concurrent identical requests (one fetch per uncached target), verify 29/30/31-day boundaries and stale-never-zeroed

### Tests for User Story 2

- [x] T010 [P] [US2] Freshness-boundary tests in `src/server/features/serp/serpEnrichment.test.ts`: 29-day-old metric → cache hit zero paid calls; exactly 30 days → still fresh; 31 days → stale and eligible for refresh; stale refresh success → cache updated; stale refresh failure → previous value preserved as stale with freshness metadata, never zeroed
- [x] T011 [P] [US2] Cross-keyword reuse test in `src/server/features/serp/serpEnrichment.test.ts`: the same competitor target across two keyword analyses hits one fresh cache entry (target-oriented key: normalized identity + metric family + provider)

### Implementation for User Story 2

- [x] T012 [US2] Verify the router path end-to-end in `src/server/features/serp/serpEnrichment.ts`: request shaping rides `SeoCacheService.getOrFetch` + `singleFlight` + metered budget asserts (assert with tests that repeat-in-window routes to cache and concurrent calls coalesce — the router already implements it; the task proves the wiring, not re-implements it)

**Checkpoint**: US2 independently testable — quickstart scenario 2 green

---

## Phase 5: User Story 3 - Provider trouble never breaks the SERP panel (Priority: P3)

**Goal**: Failure states render distinctly; base panel always visible; trace records enrichment ops; MCP parity with the opt-in flag

**Independent Test**: Inject account-paused/credits/partial/total failures (quickstart scenario 3) — each renders its correct state with full base panel; MCP untoggled response byte-identical

### Tests for User Story 3

- [x] T013 [P] [US3] UI failure-state tests for `SerpAnalysisCard` (enrichment unavailable notice, per-row unavailable, zero recorded zeros — extend existing error-card test pattern in `src/client/features/keywords/keywordResearchErrors.test.ts` or a sibling suite)
- [x] T014 [P] [US3] MCP tool tests for `get_serp_results` in `src/server/mcp/tools/get-serp-results.ts` tests: `includeCompetitiveMetrics` defaults false; untoggled response byte-identical to today; toggled carries merged Top-10 metrics only

### Implementation for User Story 3

- [x] T015 [US3] Extend the MCP tool in `src/server/mcp/tools/get-serp-results.ts` with the opt-in `includeCompetitiveMetrics` flag (default false, paid-guard description updated) thin-wrapping the same enrichment service — no parallel implementation
- [x] T016 [US3] Extend trace coverage: `serp_analysis` / `serp_competitive_enrichment` records (feature, operation, provider, cache status, status class, target counts, duration, cost metadata; secret-free) through the existing trace bridge in `src/server/lib/seo-data/trace.ts` — extend vocabulary only, no new bus
- [x] T017 [US3] Extend vocabulary boundary in `src/server/features/serp/serpBoundaries.test.ts`: zero DA/PA/DR/TF/CF-style proprietary names across the enrichment surface (provider-accurate names only)

**Checkpoint**: All user stories independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T018 Run `pnpm types:check && pnpm oxlint` and fix any violations
- [X] T019 Run quickstart.md validation scenarios end-to-end (Top-10 selection, repeat/concurrent cost, failure degradation, MCP parity + vocabulary)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies — start immediately
- **Phase 2 Foundational**: Depends on T001 — BLOCKS all user stories
- **US1 (Phase 3)**: After T002–T004 (T007 depends on T002/T003; T005/T006 first)
- **US2 (Phase 4)**: Depends on US1's service (T007); tests T010/T011 parallel with US1 tests
- **US3 (Phase 5)**: Depends on US1 (failure surfaces need the service); T013–T017 parallel among themselves
- **Polish (Phase 6)**: After all stories

### Parallel Opportunities

- T003, T004 parallel (different files)
- T005, T006 parallel (same new test file — sequential if conflicting, otherwise parallel blocks)
- US3 tasks T013, T014, T017 parallel (different files)

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 → T002–T004 → T005–T009 → STOP and VALIDATE (enriched Top-10 renders, merge-by-identity proven)
2. US1 alone delivers the product value; US2 (cost) and US3 (failure/MCP) harden it

### Incremental Delivery

US1 (pipeline + row) → US2 (cache economics) → US3 (failure isolation + MCP + trace) — each verifiable via quickstart scenarios 1, 2, 3–4.

## Notes

- No new provider, no new endpoints beyond existing DataForSEO clients, no new tables, no second resolver — P2/P6/P50.
- The frozen 003 snapshot contract is mandatory input; only additive extension of `types.ts` is allowed.
- G8: no bulk endpoint exists in the approved set, so the bound is Top-10 × dedupe × cache × coalesce — asserted by T005/T010/T011.
