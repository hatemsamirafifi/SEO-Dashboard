---
description: "Task list for feature 010: GA4 joins, goals, GA4-backed detectors, and opportunities depth"
---

# Tasks: GA4 Joins, Goals, GA4-Backed Detectors, and Opportunities Depth

**Input**: Design documents from `/specs/010-ga4-joins-goals-detectors/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: Included — the spec's Success Criteria demand reproducible test evidence (SC-001..SC-006) and
Constitution P43–P45 make regression tests mandatory for every new subsystem behavior; quickstart.md V1–V4
are the runnable validation scenarios these tests encode.

**Organization**: Tasks grouped by user story (spec.md P1–P4) so each story is independently
implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths in every description

## Path Conventions

Single project (existing monorepo): `src/` at repository root. Frontend under `src/client/`, server
features under `src/server/features/`, server functions under `src/serverFunctions/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Schema + threshold + contract groundwork shared by all user stories.

- [X] T001 Add `ga4_project_goals` table to `src/db/ga4.schema.ts` per data-model.md: columns `id` (text PK), `project_id` (text NOT NULL, FK → projects.id ON DELETE CASCADE), `organization_id` (text NOT NULL, FK → organization.id ON DELETE CASCADE), `name` (text NOT NULL), `event_name` (text NOT NULL), `match_key_event_only` (boolean NOT NULL default false), `archived_at` (text NULL), `created_at`/`updated_at` (text NOT NULL default current_timestamp via the existing `ga4Timestamps` block); indexes `ga4_goals_project_name_active_uidx` on (project_id, name) WHERE archived_at IS NULL (partial unique) and `ga4_goals_project_idx` on (project_id)
- [X] T002 Add the mirrored `ga4_project_goals` pgTable to `src/db/pg/ga4.schema.ts` with identical columns/constraints/indexes (P3 parity), export from `src/db/schema.ts` and `src/db/pg/schema.ts`
- [X] T003 Generate additive migrations via `pnpm db:generate` (produces `drizzle/00XX_*.sql` + `drizzle-pg/00XX_*.sql`; CREATE TABLE + indexes only, no backfill — P5); record the generated file names in the task body
- [X] T004 Extend `src/db/schema-parity.test.ts` with `ga4_project_goals` in the parity table list, and `src/db/ga4Migration.test.ts` with the `ga4_project_goals` table-name coverage entry (both files already enumerate ga4 tables — same pattern)
- [X] T005 Add `conversion_drop` and `engagement_drop` threshold entries to `DEFAULT_DETECTOR_THRESHOLDS` in `src/shared/intelligence-thresholds.ts` per contracts/detector-findings.md: conversion_drop { minWindowDays: 28, minCoverageRatio: 0.8, minEventsPerWindow: 10, declineRatio: 0.3 }, engagement_drop { minWindowDays: 28, minCoverageRatio: 0.8, minSessionsPerWindow: 100, declineRatio: 0.25, rankHoldRequired: true }; bump `THRESHOLD_VERSION` 2 → 3 with the in-code bump-reason comment (file-header precedent)

**Checkpoint**: Schema + thresholds in place; parity/migration tests runnable.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contract-level plumbing all user stories share. No story work begins until this phase completes.

- [X] T006 Add goal Zod schemas to `src/types/schemas/ga4.ts` per contracts/goals-api.md: `createGa4GoalSchema` { projectId, name: string trimmed 1–100, eventName: string trimmed 1–100, matchKeyEventOnly: boolean default false } `.strict()`; `listGa4GoalsSchema` { projectId, includeArchived: boolean default false } `.strict()`; `updateGa4GoalSchema` { projectId, id, name?, eventName?, matchKeyEventOnly? } `.strict()`; `archiveGa4GoalSchema` { projectId, id } `.strict()`; export `Ga4GoalRow` type
- [X] T007 Add optional `goalId: z.string().min(1).optional()` to the five analytics filter shapes in `src/types/schemas/ga4.ts` (`analyticsOverviewSchema`, `analyticsAcquisitionSchema`, `analyticsLandingPagesSchema`, `analyticsEventsSchema`, `analyticsConversionsSchema` — extend `analyticsFilterShape` once)
- [X] T008 Extend `listOpportunitiesSchema` in `src/types/schemas/opportunities.ts` per contracts/opportunities-filters.md: add single-value `page?: string`, `keyword?: string`, `source?: string`, `priority?: "critical"|"high"|"medium"|"low"` and multi-value `statuses?: OpportunityStatus[]`, `types?: string[]`, `priorities?: ("critical"|"high"|"medium"|"low")[]` (empty array = "all"; keep `.strict()`)
- [X] T009 [P] Write contract tests first (they must FAIL before implementation): goal CRUD + goal-scoped analytics scenarios from quickstart.md V1 in `src/server/features/ga4/services/Ga4GoalService.test.ts` (cap 20, active-name uniqueness, archived read-only, idempotent archive, no-data vs zero, unknown goalId NOT_FOUND, no user-summing aggregate shape per P23)

**Checkpoint**: Schemas and failing contract tests ready — user story implementation can begin.

---

## Phase 3: User Story 1 — Goals CRUD + goal-scoped analytics (Priority: P1) — MVP

**Goal**: Users create/edit/archive/list project goals and filter analytics views by a goal, with
conversions derived from per-grain event sums and honest no-data/failed states (spec US1, FR-001..FR-003).

**Independent Test**: quickstart.md V1 — create a goal, filter the conversions view by `goalId`, assert
numbers match seeded `ga4_daily_events` sums; archived/unknown goal errors; zero-row goal renders no-data.

### Implementation for User Story 1

- [X] T010 [P] [US1] Create `src/server/features/ga4/repositories/Ga4GoalRepository.ts` (persistence only, P4): `create`, `listActive` (archived_at IS NULL unless includeArchived), `getByIdForProject`, `update` (active only), `archiveById` (idempotent set archived_at), `countActiveByProject`; imports the canonical schema from `src/db/schema`; batching helpers per P4 where applicable
- [X] T011 [US1] Create `src/server/features/ga4/services/Ga4GoalService.ts` per contracts/goals-api.md: create (active cap 20 → VALIDATION_ERROR naming the cap; name unique among actives → VALIDATION_ERROR; emits `ga4_goal_change` trace, no secrets P41), list, update (archived → VALIDATION_ERROR "archived goal is read-only"; uniqueness excluding self), archive (idempotent, no error on re-archive); repository stays persistence-only
- [X] T012 [US1] Add goal-scoped conversion reads to `src/server/features/ga4/repositories/Ga4SyncRepository.ts` (or a goal-read section beside `getEventGroups`): goalConversions(projectId, propertyId, goal, from, to) = `sum(event_count)` WHERE `event_name = goal.event_name` AND (`NOT goal.match_key_event_only` OR `is_key_event = true`) AND date ∈ SUCCESS_*-covered event dates (covered-dates subquery precedent at Ga4SyncRepository.ts:1083-1124); event counts are additive — no user sums anywhere (P23)
- [X] T013 [US1] Accept `goalId` in `src/server/features/ga4/services/AnalyticsService.ts` analytics reads: validate goal (unknown/other-project/archived → NOT_FOUND-class error, never silent empty — P9); scope conversion figures to the goal binding; zero-row goal renders AnalyticsCoverage status `none` (no-data), never zero conversions (P21/P30); invalid goalId fails closed
- [X] T014 [US1] Add goal server functions to `src/serverFunctions/ga4.ts`: `createGa4Goal`, `listGa4Goals`, `updateGa4Goal`, `archiveGa4Goal` — all method POST, `requireProjectContext` middleware, strict Zod validators from T006, delegate to Ga4GoalService (P1 layering)
- [X] T015 [US1] Add authorization tests for the four goal server functions in `src/serverFunctions/ga4.authorization.test.ts` (extend the existing patterns): cross-project goal ids fail closed, missing project context rejected (P39)
- [X] T016 [P] [US1] Add goal CRUD + goal filter UI to the analytics surface: goal selector in `src/client/features/analytics/AnalyticsFilterToolbar.tsx` (active goals only; honest disabled state when the project has zero active goals), goal management controls in `src/client/features/analytics/AnalyticsPage.tsx`, view-model helpers in `src/client/features/analytics/analyticsCopy.ts` (empty vs not-connected vs no-data copy per P30)
- [X] T017 [P] [US1] Extend MCP wrappers in `src/server/mcp/tools/analytics-tools.ts`: `get_analytics_acquisition`, `get_analytics_events`, `get_analytics_conversions` accept optional `goalId`, delegate to the same AnalyticsService methods (thin adapters only — no MCP-side logic, P1.5); extend `src/server/mcp/tools/analytics-tools.test.ts` for goalId passthrough + NOT_FOUND on invalid goal
- [X] T018 [US1] Make the Phase-2 contract tests pass and extend: cap boundary (exactly 20 OK, 21st rejected), duplicate active name, archived-name reuse allowed, `match_key_event_only` filtering, no-data vs zero rendering, and an aggregate-shape test asserting no read path sums users/newUsers/activeUsers across grains or periods (SC-001, P23); run `pnpm vitest run src/server/features/ga4 src/db/schema-parity.test.ts src/db/ga4Migration.test.ts`

**Checkpoint**: US1 complete — goals CRUD + goal-scoped analytics independently testable (quickstart V1).

---

## Phase 4: User Story 2 — Organic page join (Priority: P2)

**Goal**: Per-canonical-page join of GA4, GSC, and rank grains with coverage-gated, null-for-absent
semantics and correlational wording (spec US2, FR-004..FR-006).

**Independent Test**: quickstart.md V2 — seed overlapping/non-overlapping rows incl. the 006 must-join and
must-not-join pairs; one row per canonical page; absent sources null (never zero); shuffled input order →
identical output.

### Implementation for User Story 2

- [X] T019 [P] [US2] Extend the pure join in `src/server/features/intelligence/services/AnalyticsJoinService.ts` per contracts/organic-join.md: extend `JoinGa4Page` with optional `currentEngagedSessions`/`previousEngagedSessions`/`currentGoalConversions`/`previousGoalConversions` (missing = no coverage → null, never 0); extend `JoinedUrlRow` with `ga4Engagement: { currentRate, previousRate, currentEngagedSessions, previousEngagedSessions } | null` (ratio-of-sums; sessions=0 denominator → null, not 0) and `ga4GoalConversions: { current, previous } | null`; keep purity (no repository imports) and the existing `toSorted` determinism
- [X] T020 [P] [US2] Extend `src/server/features/intelligence/services/AnalyticsJoinService.test.ts` with the contracts/organic-join.md test matrix: all 006 must-join pairs collapse across the three sources; must-not-join pairs (subdomain/port/case/cross-domain) stay distinct; GSC-only page → present.ga4=false + null ga4 metrics; GA4 page with sessions=0 → ga4Engagement null; goal conversions present/absent independent of engagement; shuffled inputs → identical sorted output (determinism)
- [X] T021 [US2] Add join fetchers: windowed pre-fetch helpers for GA4 landing rows (current/previous sessions + engagedSessions + goal-scoped event sums) and rank/GSC rows feeding `joinUrlEvidence`, colocated with the existing detector input fetcher conventions in `src/server/features/intelligence/detectors/` (pre-fetched inputs only — the pure function imports nothing, P48 live-repo conventions)
- [X] T022 [US2] Extend the join's consumer surface with per-source availability + correlational wording: mark GA4-unavailable/stale pages explicitly (coverage caps, never zero-fill) in the analytics page-join view model, and keep all user-facing wording correlational ("alongside", "observed with" — no causal verbs, P46) with per-metric source classification (P47); extend the boundary/import-ban coverage in `src/server/features/intelligence/intelligence-boundaries.test.ts` to forbid cross-source URL joins outside `AnalyticsJoinService` and URL folding outside the 006 allowlist (FR-005)
- [X] T023 [US2] Run quickstart.md V2 against seeded fixtures; verify SC-002 (100% available metrics, zero invented, all unavailability explicit, wording correlational) via `pnpm vitest run src/server/features/intelligence/services/AnalyticsJoinService.test.ts src/server/features/intelligence/intelligence-boundaries.test.ts`

**Checkpoint**: US2 complete — join independently testable (quickstart V2); US1+US2 both stand alone.

---

## Phase 5: User Story 3 — GA4-backed detectors (Priority: P3)

**Goal**: `conversion_drop` (C2b) and `engagement_drop` (C2c) detectors registered in the existing
engine with coverage gating, frozen evidence, idempotent emission (spec US3, FR-007..FR-008).

**Independent Test**: quickstart.md V3 — seeded windows emit exactly one opportunity per condition with
frozen evidence and separate impact/confidence; all failure modes skip with recorded reasons; re-scan is
idempotent.

### Implementation for User Story 3

- [X] T024 [P] [US3] Create `src/server/features/intelligence/detectors/conversionDrop.ts` per contracts/detector-findings.md: detectorKey `conversion_drop`, version 1, requiredSources ["ga4"], optionalCorroborators []; entity = project goal, site-level (entityKey = goal:{goalId} per research R5); one finding per active goal; (was: page × active goal); emit iff conversions fall ≥ declineRatio (0.3) with current-window conversions ≥ minEventsPerWindow (10); skip reasons `no_ga4_connection | no_goal_defined | events_coverage_below_ratio | below_event_floor | ga4_failed`; fetcher throws `InsufficientCoverageError` on absent GA4/failed sync/coverage < 0.8 anchoring at the latest covered date (never wall clock — ga4OrganicChange precedent); evidence freezes goalId + goalName snapshot, conversionsBefore/After, changeRatio, windowDays, ga4Keys sourceRefs, thresholdsApplied echo, explanationFact fact-only (P27/P46)
- [X] T025 [P] [US3] Create `src/server/features/intelligence/detectors/engagementDrop.ts` per contracts/detector-findings.md: detectorKey `engagement_drop`, version 1, requiredSources ["ga4"], optionalCorroborators ["rank"] (GSC feeds join presence only); single finding per page; emit iff engagement rate (engagedSessions/sessions ratio-of-sums per window) drops ≥ declineRatio (0.25) with sessions ≥ minSessionsPerWindow (100) per window and rank-held gate (rankWorsened === false when rank present; rank absent → emit with partialData ["rank_corroboration_absent"] + capped confidence); skip reasons `no_ga4_connection | landing_coverage_below_ratio | below_session_floor | rank_worsened | ga4_failed`
- [X] T026 [US3] Register both detectors: add explicit entries to `DETECTORS` in `src/server/features/intelligence/detectors/registry.ts` and both fetcher cases to the dispatcher in `src/server/features/intelligence/detectors/inputs.ts` (no auto-glob; registry uniqueness test extended in `registry.test.ts` — versions pinned, integer)
- [X] T027 [US3] Add materializer templates to `OPPORTUNITY_TEMPLATES` in `src/server/features/intelligence/services/opportunityTemplates.ts`: `conversion_drop` → type `ga4_conversion` with `factorsOf` activating `conversionSignal` (first real value for the factor — the documented header hook) + decline via `declineOf(changeRatio)` + trafficPotential from page sessions; `engagement_drop` → type `ga4_engagement`; recommendations correlation-only, from templates exclusively (P27); impact/confidence stay separate columns (P26)
- [X] T028 [P] [US3] Write detector fixture tests in `src/server/features/intelligence/detectors/conversionDrop.test.ts` and `engagementDrop.test.ts`: positive windows emit exactly one finding each with frozen evidence + separate scores; negative suite (GA4 disconnected, sync failed, coverage < 0.8, floors unmet, rank worsened) emits zero findings with every skip recorded with its reason (SC-003, G9/P28); goal-name snapshot survives goal archive/rename
- [X] T029 [P] [US3] Extend idempotency + materialization coverage: extend `src/server/features/intelligence/services/materializeFinding.test.ts` and `opportunityTemplates.test.ts` for both new types — re-scan over identical windows produces zero duplicate opportunities and zero duplicate ledger events (logicalKey/eventKey uniqueness, SC-004); boundary tests in `src/server/features/intelligence/intelligence-boundaries.test.ts` assert no second engine (G3)
- [X] T030 [US3] Run quickstart.md V3; verify via `pnpm vitest run src/server/features/intelligence` that all skip paths record reasons and emissions are idempotent over two re-runs

**Checkpoint**: US3 complete — detectors independently testable (quickstart V3).

---

## Phase 6: User Story 4 — Opportunities filters + evidence detail (Priority: P4)

**Goal**: Composable server-side filters (page/keyword/source/type/status/priority) over stored
opportunities with explicit empty states and frozen evidence detail (spec US4, FR-009..FR-010).

**Independent Test**: quickstart.md V4 — composed filter matrix returns correct sets; no-match renders
`filtered-empty` (distinct from project-empty); evidence detail renders frozen stored evidence including
ga4Keys.

### Implementation for User Story 4

- [X] T031 [P] [US4] Extend `OpportunityRepository.listByProject` in `src/server/features/intelligence/repositories/OpportunityRepository.ts` to accept the new filter object (contracts/opportunities-filters.md): AND-composed predicates over the existing indexes (project scope first, P39) — page equality, keyword equality, priority equality, statuses/types/priorities arrays as OR-within-dimension, source as `sources` array element match over `sourcesJson` (value must equal one array element, never substring; both dialects); no new indexes/columns/tables (P50)
- [X] T032 [US4] Extend `OpportunityService.listOpportunities` in `src/server/features/intelligence/services/OpportunityService.ts` to pass the new filters through unchanged (service stays orchestration-only) and `src/serverFunctions/opportunities.ts` `listOpportunities` to validate via the T008 schema (strict — unknown enum values fail at the boundary)
- [X] T033 [P] [US4] Add the filter toolbar to `src/client/features/opportunities/OpportunitiesPage.tsx`: page/keyword/source/type/status/priority controls wiring the server filters; value-less facets render disabled/not-applicable (never fake empty); update filter-state helpers in `src/client/features/opportunities/opportunitiesCopy.ts` — move type/priority filtering server-side, keep ONLY `search` as the local refinement (R4 split), feed `filteredCount` into the existing `toOpportunitiesPageView` empty/filtered-empty/error states unchanged
- [X] T034 [P] [US4] Extend `src/client/features/opportunities/opportunitiesCopy.test.ts`: filter composition fixtures (type × status, page × type, keyword × priority, source × status), filtered-empty vs empty vs error distinct states, disabled-facet rendering, and evidence-detail parse coverage for `ga4Keys` sourceRefs (existing `parseEvidenceJson`/`EvidenceView.sourceRefs` extension)
- [X] T035 [P] [US4] Extend `src/serverFunctions/opportunities.authorization.test.ts` for the new filter parameters (cross-project ids never resolve; strict validation rejects invalid enum values)
- [X] T036 [US4] Run quickstart.md V4; verify SC-005 (any two filters compose correctly, explicit empty states, frozen evidence for every type) via `pnpm vitest run src/client/features/opportunities src/serverFunctions/opportunities.authorization.test.ts`

**Checkpoint**: US4 complete — filters + evidence detail independently testable (quickstart V4).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Gates, E2E, and cross-story verification.

- [X] T037 [P] Add E2E coverage for the cross-boundary flow (goal CRUD → analytics goal filter → opportunity triage with new filters) in `e2e/opportunities-goals.spec.ts` following the existing Playwright conventions (P44; quickstart V1→V4 journey)
- [X] T038 Verify trace coverage: `ga4_goal_change` + join/detector operations emit trace entries without secrets through the existing taxonomy in the trace call sites added by T011/T019/T024/T025; the opportunity event ledger remains the authoritative record (P41/P42)
- [X] T039 Run the full quality gates (P45): `pnpm types:check`, `pnpm lint`, `pnpm vitest run src/db/schema-parity.test.ts src/db/ga4Migration.test.ts`, full `pnpm test:ci`, and `pnpm test:e2e` — SC-006 (parity green, typecheck/lint green, boundary tests prove single canonicalizer/join/engine)
- [X] T040 Run the complete quickstart.md validation (V1–V4) end-to-end against a seeded local environment and record outcomes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately. T001→T002→T003 sequential (schema → mirror → migrations); T004, T005 parallel after T003.
- **Foundational (Phase 2)**: Depends on Phase 1 (T005 thresholds; T006 schemas reference the table). T006/T007/T008 parallel (different schema files); T009 after T006. **BLOCKS all user stories.**
- **US1 (Phase 3)**: Depends on Phase 2 (T006, T007, T009). T010→T011→T014 sequential; T012/T013 depend on T010; T016/T017 parallel after T014; T018 last.
- **US2 (Phase 4)**: Depends on Phase 2 only (T007 goalId shape used by join fetchers; T008 not needed). T019/T020 parallel; T021 after T019; T022 after T021; T023 last.
- **US3 (Phase 5)**: Depends on Phase 1 (T005) + Phase 2 (T009 pattern) + US2's extended join (T019/T021 fetchers feed detectors). T024/T025 parallel; T026 after both; T027 after T026; T028/T029 parallel after T026; T030 last.
- **US4 (Phase 6)**: Depends on Phase 2 (T008). T031→T032 sequential; T033 after T032; T034/T035 parallel; T036 last. Independent of US1–US3 (filters operate on stored opportunities of any type; new types simply appear when US3 lands).
- **Polish (Phase 7)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1 (P1)**: After Foundational — no story dependencies. MVP.
- **US2 (P2)**: After Foundational — independent of US1 (join works without goals; goal-scoped join fields are optional).
- **US3 (P3)**: After Foundational + US2's join extension (detectors consume the extended join rows). Goal-scoped conversion detector needs US1's goals table + service (T010/T011) but not its UI.
- **US4 (P4)**: After Foundational — no dependencies on US1–US3.

### Within Each User Story

- Tests (contract/fixture) written and failing before implementation (T009 before US1 impl; T020/T028 colocated test-first)
- Repositories before services; services before server functions/MCP; server before client
- Core implementation before integration; story complete before the next priority

### Parallel Opportunities

- Phase 1: T004 ∥ T005 (after T003)
- Phase 2: T006 ∥ T007 ∥ T008 (different files); T009 after T006 only
- Phase 3: T016 ∥ T017 (client UI ∥ MCP tools); T010/T012 partially parallel (repository file vs read extension in different files — coordinate Ga4SyncRepository edits)
- Phase 4: T019 ∥ T020 (function ∥ its tests file)
- Phase 5: T024 ∥ T025 (different detector files); T028 ∥ T029 (different test files)
- Phase 6: T033 ∥ T034 ∥ T035 (page/copy/tests/authorization — different files)
- Phase 7: T037 ∥ T038 (e2e ∥ trace verification)
- Cross-story: US1, US2, US4 can run in parallel by different developers after Phase 2; US3 follows US2

---

## Parallel Example: User Story 1

```bash
# After T010 (repository) lands, launch in parallel:
Task: "T012 goal-scoped conversion reads in src/server/features/ga4/repositories/Ga4SyncRepository.ts"
Task: "T016 goal selector UI in src/client/features/analytics/AnalyticsFilterToolbar.tsx"
Task: "T017 MCP goalId wrappers in src/server/mcp/tools/analytics-tools.ts"
```

```bash
# Phase 5 parallel pair (different detector files):
Task: "T024 conversionDrop.ts in src/server/features/intelligence/detectors/conversionDrop.ts"
Task: "T025 engagementDrop.ts in src/server/features/intelligence/detectors/engagementDrop.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) + Phase 2 (Foundational)
2. Complete Phase 3 (US1: goals CRUD + goal-scoped analytics)
3. **STOP and VALIDATE**: quickstart V1 independently
4. Demo-able: users define goals and filter analytics by them

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → validate V1 → **MVP**
3. US2 → validate V2 → joined page views
4. US3 → validate V3 → GA4-backed opportunities
5. US4 → validate V4 → triage depth
6. Polish → gates + E2E → READY (Constitution App. C)

### Parallel Team Strategy

- Developer A: US1 (GA4 goals) · Developer B: US2 (join) · Developer C: US4 (opportunities UI) — all after Phase 2
- US3 starts when US2's join extension (T019/T021) lands

---

## Notes

- [P] = different files, no dependencies on incomplete tasks
- Story labels map to spec.md user stories for traceability
- Verify contract/fixture tests FAIL before implementing (T009, T020, T028)
- Commit after each task or logical group; one PR-sized phase per commit series
- Stop at any checkpoint to validate the story independently
- Known coordination point: T010 and T012 both touch GA4 repository files — sequence within US1 if conflicts arise
- `THRESHOLD_VERSION` bump (T005) is 2 → 3 with no production artifacts to migrate (precedent in file header)