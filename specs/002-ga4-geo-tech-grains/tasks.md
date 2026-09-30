# Tasks: GA4 Geo and Technology Grains

**Input**: Design documents from `/specs/002-ga4-geo-tech-grains/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ga4-grains.md

**Tests**: Included — Constitution P43–P45 + parity law P3 require migration, quota, and math-guard tests; quickstart.md defines scenarios.

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline verification before schema changes

- [X] T001 Verify baseline green: `pnpm test Ga4SyncService Ga4Service ga4Migration schema-parity` and `pnpm types:check` on main

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Dual-dialect schema, coverage extension, and "(other)" rollup all stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 Add `ga4_daily_geo` + `ga4_daily_technology` tables with UNIQUE composites and project/date indexes in `src/db/ga4.schema.ts`
- [X] T003 Mirror both tables in `src/db/pg/ga4.schema.ts`, add additive migration in `drizzle/` + `drizzle-pg/`, extend `src/db/ga4Migration.test.ts` and `src/db/schema-parity.test.ts`
- [X] T004 Extend `ga4_sync_coverage` grain set (`geo`, `technology`) with truncation metadata (`isTruncated`, counts when known, `otherRowPresent`) in `src/db/ga4.schema.ts` + PG mirror
- [X] T005 Implement deterministic "(other)" tail rollup with exact totals in `src/server/features/ga4/services/ga4SyncUtils.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Country breakdown from stored data (Priority: P1) 🎯 MVP

**Goal**: Analysts break sessions/engagement down by country from the stored geo grain

**Independent Test**: Sync test property, query `getAnalyticsGeo` for synced window, verify per-country metrics reconcile with summary grain

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T006 [P] [US1] Geo grain sync/read tests (upsert idempotency, sentinel dims, reconciliation) in `src/server/features/ga4/services/Ga4SyncService.test.ts`
- [X] T007 [P] [US1] Empty-window test (no geo coverage → explicit no-data state, never zeros) in `src/server/features/ga4/services/Ga4Service.test.ts`

### Implementation for User Story 1

- [X] T008 [US1] Ingest geo chunks (bounded top-N + "(other)") in `src/server/features/ga4/services/Ga4SyncService.ts`
- [X] T009 [US1] Add `getAnalyticsGeo` read fn with coverage join (`SUCCESS_*` only) in `src/server/features/ga4/services/Ga4Service.ts` and expose in `src/serverFunctions/ga4.ts`
- [X] T010 [US1] Wire country filter to stored grain with capability-gated empty states (analytics filter path)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Device/browser/OS breakdown (Priority: P2)

**Goal**: Technology slices for page-experience prioritization from the stored tech grain

**Independent Test**: View technology breakdown for synced window; verify device/browser/OS rows with stored values

### Tests for User Story 2

- [X] T011 [P] [US2] Tech grain sync/read tests (composite UNIQUE, "(other)" composite) in `src/server/features/ga4/services/Ga4SyncService.test.ts`

### Implementation for User Story 2

- [X] T012 [US2] Ingest technology chunks in `src/server/features/ga4/services/Ga4SyncService.ts`
- [X] T013 [US2] Add `getAnalyticsTechnology` read fn + device filter wiring in `src/server/features/ga4/services/Ga4Service.ts` and `src/serverFunctions/ga4.ts`

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Quota/partial honesty (Priority: P3)

**Goal**: Quota exhaustion and partial syncs surface explicit states; failed dates never zero-filled; resume backfills without duplicates

**Independent Test**: Simulate mid-sync quota failure, verify per-date states and duplicate-free resume

### Tests for User Story 3

- [X] T014 [P] [US3] Quota-failure/resume tests (halt, FAILED coverage, idempotent backfill) in `src/server/features/ga4/services/Ga4SyncService.test.ts`
- [X] T015 [P] [US3] Zero-row-vs-failure test for geo/tech grains in `src/server/features/ga4/services/Ga4Service.test.ts`

### Implementation for User Story 3

- [X] T016 [US3] Wire geo/tech chunks into existing quota-halt/resume and stale-PENDING recovery in `src/server/features/ga4/services/Ga4SyncService.ts` and `src/server/features/ga4/services/scheduledGa4Sync.ts`

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Parity, math guards, trace

- [X] T017 Run `pnpm types:check`, `pnpm oxlint`, GA4 suite, `ga4Migration`, `schema-parity`
- [X] T018 [P] Assert no `SUM(users)` violations and dimensioned-`newUsers` rollup refusal (static + behavioral per testing matrix)
- [X] T019 [P] Run quickstart.md validation scenarios 1–4; extend `ga4_sync`/`ga4_read` trace coverage

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - shares sync engine, independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - needs US1/US2 ingestion paths to exercise

### Parallel Opportunities

- T002 + T005 (schema vs util, different files); T006 + T007; T014 + T015; T018 + T019
- T003 must follow T002 (mirror); T008/T012 both touch Ga4SyncService.ts — sequence at merge

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently (country breakdown reconciles)
5. Deploy/demo if ready
