# Feature Specification: SERP Top-10 Competitive Enrichment

**Feature Branch**: `007-serp-top10-enrichment`

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: "Add bounded competitive metrics enrichment to SERP Analysis for the Top-10 organic results only: canonicalize→dedupe→bulk-fetch→merge-by-identity (never positional). Required core metrics (Domain Rank, Page Rank, referring domains, backlinks) make a row enriched; optional metrics (estimated traffic, spam/risk) render explicitly unavailable when the provider omits them — never zero, never fabricated. Separate snapshot vs target-metric cache freshness; enrichment never fails the base SERP panel; 0 vs — vs unavailable semantics; account-paused (40201) ≠ credits-unavailable (40200); trace coverage; expanded competitor row; repeat enrichment hits cache (zero paid calls); concurrent requests coalesce. Consumes the frozen normalized SerpSnapshot contract from spec 003 (G4). MCP gains an opt-in includeCompetitiveMetrics flag defaulting to false with paid guards. Implements Track S milestone S2–S3/S6–S8/S10/S12 of the Final Revised Implementation Plan (PR6, Wave 2)."

## Clarifications

### Session 2026-09-30

- Q: When the provider does not return estimated traffic or spam/risk for a target, how should the enriched row behave? → A: Required-vs-optional metric classes (binding):
  1. Required core metrics: Domain Rank, Page Rank, referring domains, backlinks. Optional: estimated
     traffic, spam/risk.
  2. A row with all required core metrics is successfully enriched even if optional metrics are missing.
  3. Missing optional metrics render explicitly "not available"/"—" with provenance; never fabricated;
     never substituted with 0.
  4. Optional-metric absence must not fail the row, hide available core metrics, or fail the panel.
  5. Availability is represented explicitly per metric (nullable values + a per-row status:
     available = all core present; partial = some core missing; unavailable = no usable enrichment
     returned; failed = provider request/error path failed). Optional metrics do not determine the status.
  6. No cross-provider fallback to fill optional metrics.
  7. Provenance per metric family where practical (availability can differ by endpoint/market).
  8. Explicit zero is a valid returned value and renders as 0; missing renders unavailable.
- Q: How fresh should cached target competitive metrics be before they are considered stale and refetched? → A: 30-day default window (binding):
  1. Target-metric freshness is independent of SERP snapshot freshness — never invalidated by a new SERP
     fetch or the keyword's checkedAt.
  2. Cached target metrics ≤ 30 days old are reused with zero paid calls; > 30 days old are stale and
     refetched on the next enrichment request, subject to normal budget/circuit-breaker/coalescing rules.
  3. Stale-vs-failed semantics preserved: a failed refresh never replaces stale metrics with zero; the
     previous value stays available as stale fallback where the cache policy supports it, with
     freshness/source metadata exposed.
  4. No proactive background refresh in this spec — refresh only when an analysis actually needs the
     target.
  5. The TTL is a named, centralized, configurable policy constant — no scattered literal day-count
     checks.
  6. Cache identity stays target-oriented (normalized URL/domain + metric family + provider), reusable
     across keywords; genuinely market/keyword-specific metrics are never stored under the generic target
     cache.
  7. Freshness-boundary tests required: 29 days → hit; exactly 30 days → still fresh; 31 days → stale;
     stale refresh success → cache updated; stale refresh failure → previous value preserved, never
     zeroed; same target across two keywords → one fresh cache entry.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See competitive strength of the Top-10 (Priority: P1)

An SEO analyst runs a SERP Analysis for a keyword and, for each of the Top-10 organic results, sees the
competitor row expanded with authority and backlink metrics. Rows for results outside the Top 10 never
gain (or trigger) enrichment. If the provider returns nothing usable for one result, that row shows
"unavailable" while the other nine stay fully enriched.

**Why this priority**: The enriched Top-10 competitor view is the core S-track deliverable; everything else
(cache, guards, semantics) protects it.

**Independent Test**: Can be fully tested by running SERP Analysis with enrichment on a fixture SERP and
asserting each of the Top-10 rows carries core metrics (or an explicit unavailable state), while position 11+
rows carry none and trigger no enrichment calls.

**Acceptance Scenarios**:

1. **Given** a normalized SERP snapshot with 10+ organic results, **When** enrichment runs, **Then** only
   the Top-10 organic results are enriched and each shows Domain Rank / Page Rank / referring domains /
   backlinks, with the expanded competitor row rendering the metric vocabulary accurately (no proprietary
   third-party metric names).
2. **Given** a provider response that omits estimated traffic for three targets, **When** rows render,
   **Then** those three show "not available" for that metric while core metrics remain visible, and the
   panel is otherwise unaffected.
3. **Given** a provider response where one target returns no usable data, **When** rows render, **Then**
   that target shows "unavailable" with per-metric provenance and the other targets are unaffected.
4. **Given** an explicit provider-returned zero (e.g. backlinks = 0), **When** the row renders, **Then** it
   shows 0 — distinct from missing ("—") and from failed ("unavailable").

---

### User Story 2 - Repeat and concurrent enrichment cost nothing extra (Priority: P2)

The analyst re-runs the same SERP Analysis minutes later, then opens it twice in parallel tabs. Metrics
come from cache and concurrent requests coalesce into one in-flight paid fetch. Only genuinely new targets
cause paid calls, and results beyond the cache freshness window are refreshed as separate cache entries
from the SERP snapshot itself.

**Why this priority**: Bounded cost is what makes enrichment shippable; a cost blowup or an N+1 pattern
would disqualify the feature (G8, Constitution P12/P15/P17).

**Independent Test**: Can be tested by replaying the same analysis twice and asserting the second run makes
zero paid provider calls, plus a concurrent-run test asserting a single coalesced fetch.

**Acceptance Scenarios**:

1. **Given** an enriched analysis whose target metrics are still within their cache freshness window,
   **When** the same analysis is repeated, **Then** zero paid provider calls are made and identical metric
   values render.
2. **Given** two concurrent requests for the same keyword analysis, **When** both complete, **Then**
   exactly one paid fetch per uncached target occurred (coalesced), and both responses agree.
3. **Given** a SERP snapshot that is still fresh but target metrics past their own window, **When** the
   analysis runs, **Then** the SERP results render from snapshot while only target metrics refresh — the
   two freshness windows are independent.
4. **Given** the MCP tool invocation, **When** competitive metrics are not explicitly requested, **Then**
   no enrichment occurs (flag defaults off) and the response is identical to the un-enriched contract.

---

### User Story 3 - Provider trouble never breaks the SERP panel (Priority: P3)

The account runs out of credits, or the provider pauses the account, or a bulk response comes back partial.
The analyst still sees the full base SERP results; the enrichment area explains what happened in user-
understandable terms; the error is classified deterministically (account paused vs credits unavailable) and
never silently retried; nothing records a zero/no-result fact from a failure.

**Why this priority**: Failure isolation preserves trust in every other number on screen (Constitution P8/P9,
G9); it is P3 because it activates only on provider trouble, but it must ship with the feature.

**Independent Test**: Can be tested by injecting provider failures (account paused, credits unavailable,
partial bulk response) and asserting the base panel renders, the failure state is explicit and correctly
classified, and no zeros are recorded.

**Acceptance Scenarios**:

1. **Given** an enrichment fetch that fails entirely, **When** the panel renders, **Then** the base SERP
   results remain fully visible with an explicit enrichment-unavailable notice — never an empty panel, never
   zeroed metrics.
2. **Given** the account-paused provider error, **When** classified, **Then** it is reported as its own
   distinct class and never as a billing/credits condition (and vice versa for credits-unavailable).
3. **Given** a bulk response covering only some requested targets, **When** merged, **Then** each response
   item is matched to its target by normalized identity — never by array position — and unmatched targets
   render "unavailable".
4. **Given** any provider failure, **When** retry logic evaluates, **Then** permanent account/billing
   failures are not blindly retried; each attempt and outcome is observable in the trace.

---

### Edge Cases

- Fewer than 10 organic results present: enrichment covers whatever exists (e.g. 4 results → 4 enriched).
- Duplicate domains/URLs across the Top-10 (same domain twice): dedupe targets before the bulk fetch;
  each result row still renders its own metrics from the shared target.
- A Top-10 result whose URL cannot be canonicalized: it renders as unavailable for enrichment rather than
  blocking the batch or being dropped silently.
- Cache entry present but marked failed/stale: treated per freshness policy as a candidate for refetch,
  not served as authoritative metrics; a failed refresh of a stale entry never zeroes the previous value —
  it stays visible as stale with freshness provenance until a successful refresh replaces it.
- Enrichment enabled but provider integration disabled or unconfigured: behaves like explicit
  "unavailable" with reason, zero paid calls, no panel impact.
- A genuinely keyword- or market-specific metric must not be stored under the generic target cache —
  cross-keyword cache reuse applies only to genuinely target-scoped metrics.
- Metrics arriving from a provider snapshot dated earlier than the SERP snapshot: freshness provenance
  must be visible per metric (snapshot date ≠ fetch date; Constitution P19).
- Concurrent enrichment requests for overlapping-but-different keyword analyses: coalescing must not
  leak one request's metrics into another keyword's rows.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Competitive enrichment MUST apply only to the Top-10 organic results of a normalized SERP
  snapshot; results outside the Top 10 MUST NOT be enriched nor trigger paid calls (G8).
- **FR-002**: Enrichment MUST follow the bounded pipeline: canonicalize URLs/domains, dedupe targets,
  fetch via supported bulk endpoints, cache reusable target metrics, and merge by normalized identity;
  provider array order MUST NOT be used as identity.
- **FR-003**: Core metrics (Domain Rank, Page Rank, referring domains, backlinks) MUST be presented with
  provider-accurate names; optional metrics (estimated traffic, spam/risk) MUST render explicitly
  unavailable ("—"/"not available") when absent — never fabricated, never substituted with zero.
  Explicit provider-returned zeros MUST render as 0.
- **FR-004**: Each enriched target MUST carry a per-row status (available / partial / unavailable / failed)
  derived only from core-metric presence, plus per-metric provenance where practical.
- **FR-005**: SERP snapshot freshness and target-metric freshness MUST be tracked as separate cache
  windows: a fresh snapshot MUST NOT block target-metric refresh, and stale target metrics MUST NOT
  force a new SERP fetch. Target-metric freshness defaults to a 30-day window governed by one named,
  configurable policy constant; refresh happens only on actual analysis need (no proactive background
  refresh), and a failed refresh MUST never replace stale metrics with zero — the previous value remains
  available as stale fallback with freshness/source metadata where the cache policy supports it.
- **FR-006**: Repeating an analysis within the target-metric cache window MUST make zero paid provider
  calls; concurrent requests for the same targets MUST coalesce into one in-flight paid fetch.
- **FR-007**: Base SERP results MUST remain fully visible when enrichment fails wholly or partially;
  failure MUST render as an explicit unavailable/failed state — never as zero, "no result", or a hidden
  panel (G9).
- **FR-008**: Provider failures MUST be classified deterministically, keeping account-paused (40201) and
  credits-unavailable (40200) distinct; permanent account/billing failures MUST NOT be blindly retried.
- **FR-009**: Enrichment operations MUST emit trace records (feature, operation, provider, cache status,
  status class, target counts, duration, cost metadata) without secrets.
- **FR-010**: The MCP surface MUST expose competitive metrics strictly opt-in via an explicit flag defaulting
  to false, guarded by the same bounded pipeline — a thin wrapper over the same service, never a parallel
  implementation.
- **FR-011**: Enrichment MUST NOT trigger as a side effect of merely viewing dashboards or reports
  (render-time paid reads prohibited, G10); it runs only on the explicit SERP-analysis enrichment path.

### Key Entities

- **EnrichmentTarget**: One deduplicated Top-10 result target (normalized URL/domain) sent for bulk metric
  fetch; shared across results when duplicates exist.
- **CompetitiveMetrics**: Per-target metric set: core metrics (Domain Rank, Page Rank, referring domains,
  backlinks), optional metrics (estimated traffic, spam/risk), each nullable with explicit availability, plus
  per-row status and provenance (source, snapshot date, fetch date).
- **TargetMetricCacheEntry**: Cached per-target metrics with their own freshness window (30-day default
  via one named, centralized policy constant), independent of the SERP snapshot cache; keyed on
  normalized target identity (URL/domain + metric family + provider) so entries are reusable across
  keywords, never keyword-scoped.
- **EnrichmentTraceRecord**: Observability record for enrichment operations (counts, cache status, outcome
  class); never a source of truth.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: For a fixture SERP with 10+ results, exactly the Top-10 results render enriched (or
  explicitly unavailable), position 11+ results render un-enriched, and 100% of merge matching keys on
  normalized identity (zero positional merges).
- **SC-002**: A repeat analysis within cache windows completes with zero paid provider calls; a concurrent
  pair of identical requests coalesces to exactly one paid fetch per uncached target; freshness-boundary
  tests pass (29 days → cache hit, exactly 30 days → still fresh, 31 days → stale and eligible for
  refresh, stale-refresh failure preserves the previous value — never zeroed, and one target reused
  across two keywords hits the same fresh cache entry).
- **SC-003**: Injected failure modes (account paused, credits unavailable, partial bulk, total failure)
  each render their correct distinct state with the base panel fully visible, and zero false zero/no-result
  values are recorded in any failure scenario.
- **SC-004**: The full test matrix (selection, bulk fetch, merge, value semantics 0/—/unavailable, error
  classification, UI rendering, cache behavior) passes; the mandatory matrix is named in the plan and every
  cell has at least one automated test.

## Assumptions

- The frozen normalized SERP contract from spec 003 (schemas, identity keys, boundary guards) is a
  mandatory input and is extended additively only where this feature's contract requires (competitive
  metrics, opt-in flag); the base snapshot shape is not redesigned.
- Only already-approved providers are used via their supported bulk endpoints; no new provider is
  introduced, and no cross-provider fallback fills optional metrics.
- Enrichment is requested from the existing SERP Analysis surface and its MCP twin; dashboards, reports,
  and standard page rendering never trigger it.
- Existing cache infrastructure patterns are reused with new, dedicated cache entries; no MVP migration is
  rewritten.
- Estimated traffic renders only where actually provided by the provider; the UI labels it as a provider
  estimate, distinct from first-party analytics traffic.
- SERP feature families (PAA, featured, etc.) and their UI are out of scope here (spec 011 consumes the
  same normalized contract for that).
