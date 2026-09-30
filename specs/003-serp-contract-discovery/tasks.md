# Tasks: SERP Contract Discovery and Freeze

**Input**: Design documents from `/specs/003-serp-contract-discovery/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/serp-snapshot.md

**Tests**: Included — fixture validation + no-raw-parsing static check + vocabulary audit (G4 evidence).

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline before read-only discovery

- [X] T001 Verify baseline green: SERP feature tests (`pnpm test serp`) and `pnpm types:check` on main

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Discovery outline all stories build on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 Draft discovery outline with file references (entries, resolver, adapters, normalization, cache/TTLs, singleFlight, cost, trace) in `specs/003-serp-contract-discovery/research.md`

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Real pipeline documented (Priority: P1) 🎯 MVP

**Goal**: Maintainer can trace one keyword end-to-end from the discovery report alone

**Independent Test**: Unfamiliar engineer walkthrough with zero corrections to file references

### Tests for User Story 1

- [X] T003 [US1] Engineer-walkthrough dry run: trace one keyword via report refs only, log discrepancies in `specs/003-serp-contract-discovery/research.md`

### Implementation for User Story 1

- [X] T004 [US1] Complete discovery report (actual path, types, adapters, resolver order, cache keys, coalescing, cost, trace) in `specs/003-serp-contract-discovery/research.md`
- [X] T005 [US1] Record docs-vs-code discrepancies with code-authoritative resolutions in `specs/003-serp-contract-discovery/research.md`

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Single frozen contract (Priority: P2)

**Goal**: Frozen `SerpSnapshot` types + fixtures all consumers reference; G4 satisfiable

**Independent Test**: Full + sparse fixtures validate; downstream packages cite the contract

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T006 [P] [US2] Full snapshot fixture (all families) in `src/server/features/serp/serpSnapshot.test.ts`
- [X] T007 [P] [US2] Sparse snapshot fixture (half families absent → absent, not fabricated) in `src/server/features/serp/serpSnapshot.test.ts`

### Implementation for User Story 2

- [X] T008 [US2] Freeze normalized `SerpSnapshot`/`SerpOrganicResult`/`SerpFeatureSet` Zod types with logical identity rule in `src/server/features/serp/types.ts`
- [X] T009 [US2] Fixture validation tests (identity canonicalization, full-ISO `checkedAt`, provider-as-provenance) in `src/server/features/serp/serpSnapshot.test.ts`
- [X] T010 [US2] Freeze `specs/003-serp-contract-discovery/contracts/serp-snapshot.md` and record G4 sign-off for packages 007/011

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Honest metric vocabulary (Priority: P3)

**Goal**: Provider-accurate names only; no raw provider parsing outside resolver

**Independent Test**: Vocabulary review vs provider docs clean; static check green

### Tests for User Story 3

- [X] T011 [P] [US3] No-raw-parsing static check (UI/detectors import normalized types only) alongside `src/server/features/intelligence/intelligence-boundaries.test.ts` patterns

### Implementation for User Story 3

- [X] T012 [US3] Vocabulary audit vs provider docs; remove any DA/PA/DR/TF/CF labels from SERP contract surfaces in `src/server/features/serp/types.ts` and `specs/003-serp-contract-discovery/contracts/serp-snapshot.md`

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: G4 gate closure

- [X] T013 Run `pnpm types:check`, `pnpm oxlint`, SERP suite
- [X] T014 [P] Run quickstart.md validation scenarios 1–4; update G4 status in `docs/speckit-implementation-plan.md`

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
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - needs discovery file refs
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - needs frozen types to audit

### Parallel Opportunities

- T006 + T007 (separate fixtures); T011 can start once T008 lands
- US phases sequential preferred (US2 builds on US1 refs, US3 audits US2 output)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Engineer walkthrough with zero corrections
5. Then US2 (the G4 contract), then US3
