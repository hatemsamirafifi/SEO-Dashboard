# Tasks: Striking Distance Detector

**Input**: Design documents from `/specs/004-striking-distance-detector/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/detector-finding.md

**Tests**: Included — detector fixture matrix + lifecycle + registry/boundary guards (Constitution P43–P45).

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline before detector work

- [X] T001 Verify baseline green: `pnpm test intelligence detectors registry` and `pnpm types:check` on main

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Single band definition + registry slot all stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 Add shared band constants (`STRIKING_DISTANCE_MIN_POSITION = 11`, `STRIKING_DISTANCE_MAX_POSITION = 20`) in `src/shared/intelligence.ts`
- [X] T003 Add superset comment to the existing 5–20 near-miss helper in `src/server/features/gsc/searchPerformanceReport.ts` (comment only, no behavior change)

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Page-one-adjacent keywords as opportunities (Priority: P1) 🎯 MVP

**Goal**: In-band, above-floor keywords materialize as stable opportunities with frozen evidence

**Independent Test**: Labeled fixtures (in/out of band, above/below floor, edges 10/11 + 20/21) emit exactly the qualifying set

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T004 [P] [US1] Positive/edge fixtures (band edges, floor boundary, multi-URL query) in `src/server/features/intelligence/detectors/strikingDistance.test.ts`

### Implementation for User Story 1

- [X] T005 [US1] Implement `strikingDistance` detector (pure `detect`, injected thresholds echoed in evidence, observational only) in `src/server/features/intelligence/detectors/strikingDistance.ts`
- [X] T006 [US1] Register detector in explicit list in `src/server/features/intelligence/detectors/registry.ts` (extends `registry.test.ts` uniqueness)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Silence on missing/failed data (Priority: P2)

**Goal**: Zero false opportunities from thin impressions, partial coverage, or failed rank; skips recorded

**Independent Test**: Each failure-mode fixture emits zero opportunities with a recorded skip reason

### Tests for User Story 2

- [X] T007 [P] [US2] Failure-mode fixtures (below floor, partial coverage, failed/missing rank) with skip-reason assertions in `src/server/features/intelligence/detectors/strikingDistance.test.ts`

### Implementation for User Story 2

- [X] T008 [US2] Wire coverage gating + skip reasons (`below_impression_floor | incomplete_coverage | rank_unavailable | source_failed`) through `src/server/features/intelligence/services/FindingService.ts` paths used by the detector

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Stable lifecycle without duplicates (Priority: P3)

**Goal**: In-place updates, terminal preservation, recurrence linkage, version supersession — no model changes

**Independent Test**: Double-scan, dismiss-and-requalify, and version-bump scenarios behave per lifecycle rules

### Tests for User Story 3

- [X] T009 [P] [US3] Lifecycle tests (in-place update, no-reopen, recurrence link, supersede) in `src/server/features/intelligence/services/materializeFinding.test.ts` (or detector-adjacent suite per repo layout)

### Implementation for User Story 3

- [X] T010 [US3] Verify materializer integration with zero model changes (existing templates, scoring, events) — gap-fix only if a detector-specific template is missing in `src/server/features/intelligence/services/opportunityTemplates.ts`

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Engine-wide guards

- [X] T011 Run `pnpm types:check`, `pnpm oxlint`, intelligence + boundaries + materializer suites
- [X] T012 [P] Run quickstart.md validation scenarios 1–4

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
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - needs US1 detector to exercise gating
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - needs US1 emissions to exercise lifecycle

### Parallel Opportunities

- T004 + T007 + T009 (all test files, can be drafted in parallel once interfaces are sketched)
- T005 must precede T008/T010 (detector exists before gating/lifecycle integration)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently (precision/recall 100% on fixtures)
5. Then US2 (trust), then US3 (lifecycle)
