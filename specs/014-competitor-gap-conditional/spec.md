# Feature Specification: Competitor-Gap Conditional Package (Input Spike → Conditional Detector & Workflow)

**Feature Branch**: `014-competitor-gap-conditional`

**Created**: 2026-10-09

**Status**: Draft — **G5 conditional**. This package MUST NOT proceed to `/speckit.plan` or implementation until the input spike (PR19) produces a recorded go/no-go verdict. On a NO-GO or BLOCKED verdict, this entire package is dismissed and no competitor-gap detector, workflow, or UI ships.

**Input**: User description: "spec 014 — F:\SEO-Dashboard\docs\speckit-implementation-plan.md §3 row 014: Competitor-gap conditional (PR19 → PR20 → E1d · C2d/C2e) — input spike first (DataForSEO quality, crawl coverage, cost, entity identity, cache reuse) → go/no-go → detector/workflow only on pass (Constitution Principle 36 / Gate G5). Never blocks other packages."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Recorded go/no-go verdict on competitor-gap inputs (Priority: P1)

A maintainer runs a time-boxed input spike that measures the real quality, coverage, cost, and cache behavior of the competitor-domain inputs a competitor-gap detector would depend on (DataForSEO domain-keyword/competitor endpoints, crawl/audit coverage, and existing caches). The spike outputs exactly one verdict — `COMPETITOR_GAP_READY` or `COMPETITOR_GAP_BLOCKED` — with the measured evidence attached, and the verdict is durably recorded so the rest of the program can rely on it.

**Why this priority**: Gate G5 (Constitution Principle 36) makes this spike the sole artifact that decides whether any downstream competitor-gap work exists. It protects the program from shipping a detector/workflow built on inputs that are untrustworthy, uneconomical, or both — and it halts only package 014, never other packages (plan §3 note).

**Independent Test**: Fully testable as a standalone spike: execute the spike measurement plan against recorded/representative provider responses, produce the verdict document with evidence, and record the verdict durably. Delivers value by itself — a justified, auditable go/no-go decision even if the downstream feature never ships.

**Acceptance Scenarios**:

1. **Given** the spike plan is defined, **When** measurements complete (input match rate, missing-data rate, cost per project analysis, entity-identity stability, cache hit behavior), **Then** exactly one verdict `COMPETITOR_GAP_READY` or `COMPETITOR_GAP_BLOCKED` is recorded, with the measured evidence frozen alongside it.
2. **Given** a `COMPETITOR_GAP_BLOCKED` verdict, **When** any attempt is made to plan/implement the detector or workflow work in this package, **Then** it is refused and the package status remains Draft/dismissed — with no effect on packages 001–013.
3. **Given** the verdict is recorded, **When** a reviewer inspects it, **Then** the evidence is immutable (frozen at spike time) and the reasoning for the verdict is reconstructible without re-running the spike.

---

### User Story 2 - Competitor-gap opportunity detection on proven inputs (Priority: P2, conditional on Story 1 = READY)

An SEO professional using a project connected to Search Console sees opportunities of the form "competitor X ranks in the top results for query set where the user's site is absent or materially weaker", produced by the existing Intelligence Engine from the spike-proven inputs, with stable identity, frozen evidence, and explicit no-trigger semantics when inputs fail or coverage is insufficient.

**Why this priority**: This is the actual user value (Track C opportunities), but it is strictly subordinate to the spike verdict — it only exists after the inputs are proven trustworthy and economical. Modeled as an independent story so it can be shipped as its own slice once unblocked.

**Independent Test**: With a READY verdict recorded, the detector can be fully tested with fixture inputs: triggering cases produce stable, deduplicated opportunities with evidence; provider-failure and insufficient-coverage fixture cases produce no findings and no opportunities.

**Acceptance Scenarios**:

1. **Given** a READY verdict and stored project/competitor data, **When** the intelligence scan runs, **Then** competitor-gap findings appear as opportunities through the existing Opportunity model (impact/confidence separate), with frozen evidence and stable finding keys — no second engine, no positional merge.
2. **Given** any input source fails or coverage is incomplete, **When** the scan evaluates competitor-gap, **Then** the detector does not trigger (no findings, no opportunities) and the no-trigger state is distinguishable from "no gap observed".
3. **Given** the same inputs re-evaluated, **When** a scan re-runs, **Then** no duplicate opportunities are created (idempotent materialization) and repeat analysis performs zero uncached paid provider calls.

---

### User Story 3 - Competitor-gap autopilot workflow on frozen evidence (Priority: P3, conditional on Story 2)

A user can run a competitor-gap Autopilot workflow (E1d) that orchestrates over the frozen evidence and stored opportunities — never inventing gaps itself — producing observational, non-causal output under the same allowlist/budget/idempotency constraints as all other autopilot workflows.

**Why this priority**: Lowest priority in the package — orchestration comes last, after detection is real and stable, consistent with the plan placing E-track orchestration last ("needs stable evidence contracts", plan §5).

**Independent Test**: E2E start → poll → resume of the workflow against frozen evidence fixtures; output language review passes; no paid provider calls occur at workflow run time.

**Acceptance Scenarios**:

1. **Given** the detector is producing opportunities and a READY verdict is recorded, **When** the user starts the competitor-gap workflow, **Then** steps execute over frozen evidence with durable step history and resumable attempts, consuming stored data only (no render-time or run-time unguarded paid calls).
2. **Given** workflow output is generated, **When** the language is reviewed, **Then** it contains no causal claims, no invented rankings/gaps/uplift, and clearly distinguishes observed facts from recommendations.

---

### Edge Cases

- Spike evidence is contradictory (e.g., good match rate but cost per analysis exceeds the budget bound): the verdict rules must define weighted pass/fail thresholds, and the verdict defaults to BLOCKED on any unmet hard threshold.
- Provider returns partial bulk competitor data mid-spike: merge-by-identity semantics apply; partial data must not inflate match-rate measurements.
- A project's competitors are set but the competitor domains have near-zero keyword overlap with the market: detector yields "no data" state, never "no opportunities because inputs failed" ambiguity and never a false "site is winning everywhere" implication.
- Verdict recorded as READY, but input quality later degrades (e.g., endpoint behavior changes): detector no-trigger/partial semantics still apply per Principle 28; spike verdict is not a permanent license.
- Project has zero competitors configured: both detector and workflow present an explicit not-configured state, not an empty result set.

## Requirements _(mandatory)_

### Functional Requirements

**Part A — Input spike (ships first; the only unconditional part of this package)**

- **FR-001**: The system MUST execute a time-boxed input spike measuring, at minimum: (a) keyword/competitor data quality for competitor domains (match rate, missing-field rate), (b) crawl/audit coverage relevant to gap evidence, (c) estimated and measured cost per project-level analysis, (d) entity-identity stability of competitor domains/URLs via the canonical URL identity strategy produced by package 006, (e) cache reuse behavior (repeat analysis must hit cache, not re-pay).
- **FR-002**: The spike MUST produce exactly one verdict — `COMPETITOR_GAP_READY` or `COMPETITOR_GAP_BLOCKED` — against explicit, pre-registered pass thresholds (no post-hoc rationalization), with frozen evidence attached.
- **FR-003**: The verdict and its evidence MUST be durably recorded and immutable; re-running the spike appends a new verdict record rather than mutating the old one.
- **FR-004**: On `COMPETITOR_GAP_BLOCKED` (or no verdict), all Part B/C work in this package MUST remain unplanned and unimplemented, and the failure of this package MUST have no effect on any other package.
- **FR-005**: The spike MUST NOT introduce any new provider, resolver, engine, or queue; it measures the approved provider set only.

**Part B — Detector (conditional on Part A = READY)**

- **FR-006**: Competitor-gap detection MUST be implemented inside the existing Intelligence Engine detector registry with the established versioning model — no parallel detector system.
- **FR-007**: Detection MUST NOT trigger on provider failure, unavailable inputs, or insufficient coverage (explicit no-trigger/partial semantics); a failure state MUST be indistinguishable from neither "zero gap" nor "no competitors".
- **FR-008**: Opportunities MUST materialize through the existing Opportunity model with `impactScore` and `confidenceScore` kept separate, frozen evidence, and stable, idempotent finding keys (re-scans never duplicate).
- **FR-009**: Detection inputs MUST be resolved cache-first; repeat analysis over unchanged inputs MUST require zero additional paid provider calls, and all paid input paths MUST be bounded (bulk, deduped, per-budget).

**Part C — Autopilot workflow (conditional on Parts A and B)**

- **FR-010**: The competitor-gap workflow (E1d) MUST orchestrate exclusively over stored findings/opportunities and frozen evidence produced by Part B; it MUST NOT compute competitor gaps independently of the Intelligence Engine.
- **FR-011**: The workflow MUST obey the standard autopilot constraints: explicit workflow allowlist, bounded steps/tool calls, durable step history, idempotency, resumable attempts.
- **FR-012**: All user-facing output (detector evidence, opportunity copy, workflow summaries) MUST use observational language: no causal claims, no invented rankings/gaps/uplift figures, and a clear distinction between observed fact and recommendation.

### Key Entities _(include if feature involves data)_

- **CompetitorGapVerdict (spike verdict record)**: One per spike run; immutable verdict enum (`COMPETITOR_GAP_READY` | `COMPETITOR_GAP_BLOCKED`), frozen measurement evidence (match rates, coverage, cost, identity stability, cache behavior), threshold set evaluated, recorded-at timestamp; scoped to the organization/project context that ran it.
- **Competitor reference**: A domain associated with a project used as gap comparison input; identity MUST be expressed via the canonical identity strategy (package 006); reused from existing project/competitor configuration where it already exists — no parallel entity.
- **Competitor Gap Finding → Opportunity**: Standard Intelligence Engine Finding materialized into the existing Opportunity model; carries frozen evidence (query sets, competitor positions, user-site absence/weakness signals), stable `findingKey`, impact/confidence pair, and provenance classification (e.g., `THIRD_PARTY_ESTIMATE` / `SERP_OBSERVED`).

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: The spike produces a single recorded verdict within its time box, with 100% of pre-registered thresholds either explicitly passed or explicitly failed — no unmeasured dimensions at verdict time.
- **SC-002**: The recorded verdict is audit-reconstructible: a reviewer can verify the decision from frozen evidence alone, without re-running any measurement, in under 15 minutes.
- **SC-003**: A `BLOCKED` verdict results in zero downstream artifacts: no detector, no workflow, no schema, no UI shipped for competitor gap — and zero regressions or blocks in packages 001–013.
- **SC-004**: If READY: over a repeated detection run on unchanged inputs, 0 additional paid provider calls occur (cache-hit rate 100% for repeat analysis), and re-scans create 0 duplicate opportunities.
- **SC-005**: If READY: 100% of provider-failure and insufficient-coverage fixture cases produce no findings and no opportunities (failure never becomes "no gap").
- **SC-006**: If the workflow ships: a start → poll → resume cycle completes for 100% of fixture scenarios with no run-time paid provider calls, and 100% of sampled workflow output passes the language review (no causal claims, no invented metrics).

## Assumptions

- The spike's measurement harness reuses existing recording/fixture infrastructure and the approved provider set (Principle 6); it does not require new paid volume beyond its declared budget cap.
- Competitor references needed by the detector come from existing project/competitor configuration surfaces (SERP/competitive features from packages 003/007), not a new entity system.
- The canonical URL identity from package 006 (G1) is complete before Part B detection begins; the spike evaluates identity stability but Part B joins depend on G1.
- Spike budget and time box are set by the maintainer at execution time and recorded with the verdict; defaults: a small fixed number of representative competitor domains and a capped number of paid calls.
- If the verdict is READY, thresholds and evidence become part of the package's acceptance record; a later spike may supersede (not rewrite) the verdict if provider behavior changes.
- No user-facing dashboard/reports surface is in scope for this package beyond opportunities produced by the detector; presentation rides on existing opportunity UI (package 010) and, if needed, is handled there.

## Out of Scope

- Any competitor-gap detection or autopilot workflow implementation before a recorded `COMPETITOR_GAP_READY` verdict.
- New SEO providers, new resolvers, new job/queue infrastructure, or a second intelligence engine (prohibited by Principles 2, 6).
- SERP enrichment expansion beyond Top 10, historical SERP trends, and automatic MCP enrichment of competitor data ("Later" list, plan §21).
- Competitor benchmarking dashboards, share-of-voice reporting, or generic market-analysis products — this package is detection + workflow only.
