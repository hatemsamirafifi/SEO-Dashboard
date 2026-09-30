# Tasks: Dashboard Stored Rollups

**Input**: Design documents from `/specs/001-dashboard-stored-rollups/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/overview-api.md

**Tests**: Included — Constitution P43–P45 requires regression tests for new subsystem behavior; quickstart.md defines the scenarios.

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline verification before extending the dashboard read model

- [X] T001 Verify baseline green: run `pnpm test DashboardService` and `pnpm types:check` on main before changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared window logic, contract types, and failure-state mapping all stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 Implement shared date-boundary resolver (current + immediately-preceding equal-length day-aligned windows) in `src/server/features/gsc/searchPerformanceReport.ts`
- [X] T003 [P] Add `SectionPayload`, `PeriodDelta` (with `previous == null ⟹ change/changePct == null` invariant), and `CoverageNote` types in `src/shared/intelligence.ts`
- [X] T004 [P] Add coverage-to-`SectionState` mapper (11-state vocabulary, failure never zero) in `src/shared/intelligence.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Stored intelligence overview with period deltas (Priority: P1) 🎯 MVP

**Goal**: SEO Performance, Search Visibility, and Traffic & Engagement render stored values with previous-period deltas and zero paid calls

**Independent Test**: Sync GSC/GA4, call `getDashboardOverview`, verify three sections show values + deltas + coverage labels with no paid provider activity in trace

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T005 [P] [US1] Overview contract test (8 sections, delta invariant, unavailable-on-failure) in `src/server/features/dashboard/services/DashboardService.test.ts`
- [X] T006 [P] [US1] Null-delta test (missing prior coverage → null delta, never 0%/±100%) in `src/server/features/dashboard/services/DashboardService.test.ts`

### Implementation for User Story 1

- [X] T007 [P] [US1] Aggregate SEO Performance section (clicks, impressions, CTR, avg position + deltas) in `src/server/features/dashboard/services/DashboardService.ts`
- [X] T008 [P] [US1] Aggregate Search Visibility section (Top 3/10/100, improved/declined, unavailable counts) in `src/server/features/dashboard/services/DashboardService.ts`
- [X] T009 [P] [US1] Aggregate Traffic & Engagement section (sessions, organic, engaged, rate + coverage) in `src/server/features/dashboard/services/DashboardService.ts`
- [X] T010 [US1] Wire extended `getDashboardOverview` in `src/serverFunctions/dashboard.ts` (project-scoped, stored reads only)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Conversions, opportunities, health, backlinks glance (Priority: P2)

**Goal**: Remaining four sections reflect stored state including not-configured/stale variants

**Independent Test**: Set up goals, opportunities, audit, backlink snapshot independently; verify each section reflects stored state

### Tests for User Story 2

- [X] T011 [P] [US2] Section tests (Conversions not-configured, stale/no-audit, empty backlinks) in `src/server/features/dashboard/services/DashboardService.test.ts`

### Implementation for User Story 2

- [X] T012 [P] [US2] Aggregate Conversions section (key events, transactions, not-configured state) in `src/server/features/dashboard/services/DashboardService.ts`
- [X] T013 [P] [US2] Aggregate Opportunities section (Critical/High/Medium counts + deep link) in `src/server/features/dashboard/services/DashboardService.ts`
- [X] T014 [P] [US2] Aggregate Technical Health section (audit health, important-page issues, stale states) in `src/server/features/dashboard/services/DashboardService.ts`
- [X] T015 [US2] Aggregate Backlinks section (totals, referring domains, new/lost) in `src/server/features/dashboard/services/DashboardService.ts`

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Recent changes feed (Priority: P3)

**Goal**: Insight feed distinguishes facts from recommendations with source badges

**Independent Test**: Seed stored insights; verify feed renders fact vs recommendation blocks with badges

### Tests for User Story 3

- [X] T016 [P] [US3] Recent-changes feed test (fact/recommendation split, badges) in `src/server/features/dashboard/services/DashboardService.test.ts`

### Implementation for User Story 3

- [X] T017 [US3] Aggregate Recent Changes section from stored insights in `src/server/features/dashboard/services/DashboardService.ts`

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Gates and contract freeze for A1 consumers

- [X] T018 Run `pnpm types:check`, `pnpm oxlint`, and full dashboard test suite
- [X] T019 [P] Run quickstart.md validation scenarios 1–4 and freeze response shape vs `contracts/overview-api.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - independently testable (needs stored insights)

### Parallel Opportunities

- T003 + T004 (different concerns, same file — coordinate, or split files); T005 + T006; T007 + T008 + T009; T012 + T013 + T014
- US1/US2/US3 phases can run in parallel once Foundational completes (same-file edits in DashboardService.ts need sequencing at merge)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently (values + deltas + zero paid calls)
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
