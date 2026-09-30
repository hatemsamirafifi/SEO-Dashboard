# Tasks: Lost-Backlink Opportunity

**Input**: Design documents from `/specs/008-lost-backlink-opportunity/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/lost-backlink-opportunity.md

**Tests**: Included — Constitution P43–P45 requires the floor matrix, no-trigger negatives, and idempotency tests; quickstart.md defines the scenarios.

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline verification before adding the detector

- [x] T001 Verify baseline green: run `pnpm test backlinkChange && pnpm test registry && pnpm test intelligence-boundaries && pnpm test materializeFinding` plus `pnpm types:check` before changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The threshold entry all stories consume

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 Add the `lost_backlinks` threshold entry in `src/shared/intelligence-thresholds.ts` `DEFAULT_DETECTOR_THRESHOLDS`: `{ minSnapshots: 2, freshnessDays: 30, minReferringDomains: 3 }` (floor unit = lost referring domains, never raw backlink count); keep `THRESHOLD_VERSION` at 2 (no existing band changes)

**Checkpoint**: Foundation ready — threshold key resolvable via `defaultThresholdsFor("lost_backlinks")`

---

## Phase 3: User Story 1 - See notable lost backlinks as a prioritized opportunity (Priority: P1) ⭐ MVP

**Goal**: The `lost_backlinks` detector emits one prioritized opportunity with frozen named-domain evidence when the floor is met; below floor and failures stay silent

**Independent Test**: Seed two snapshots with 5 lost referring domains (floor 3), run the scan, verify exactly one opportunity with named domains + timestamps + split scores; seed 1 lost domain, verify zero opportunities

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T003 [P] [US1] Floor matrix tests in a new `src/server/features/intelligence/detectors/lostBacklinks.test.ts`: 0, 1, 2 lost referring domains → no emission; exactly 3 → eligible; 5+ → eligible; null totals → no emission (unknown ≠ 0); thresholds echoed in evidence (`minReferringDomains`, `minSnapshots`, `freshnessDays`)
- [x] T004 [P] [US1] Evidence-shape tests in `lostBacklinks.test.ts`: frozen evidence carries bounded top-N lost domain names, aggregate counts, `snapshotFrom`/`snapshotTo`, `two_point_heuristic` partial-data label, confidence capped per the heuristic convention (mirror `backlinkChange.ts:139-176` conventions)

### Implementation for User Story 1

- [x] T005 [US1] Implement the detector + input fetcher in `src/server/features/intelligence/detectors/lostBacklinks.ts` (new): fetch the two newest snapshots via `BacklinkSnapshotRepository.getRecentForProject` (mirror `fetchBacklinkChangeInput` gating in `backlinkChange.ts:76-114` — fewer than 2 or stale newest ⇒ `InsufficientCoverageError`); floor-check on stored aggregates (`lostReferringDomains ≥ 3`); only on trigger, resolve bounded top-N lost-domain names via the cached referring-domains service path (`profileReferringDomainsPage` through the DataRouter — single lost-filtered bounded page, no per-domain N+1); name-resolution failure ⇒ `InsufficientCoverageError` (never a loss); detector def `detectorKey: "lost_backlinks"`, version 1, `requiredSources: ["backlinks"]`, `minConfidenceToEmit: 40`, same snapshot coverage requirement as `backlink_change`
- [x] T006 [US1] Add the `OPPORTUNITY_TEMPLATES.lost_backlinks` entry in `src/server/features/intelligence/services/opportunityTemplates.ts` (next to `backlink_change:283`): `type: "backlinks"` (existing filters apply), reclaim-oriented recommendation (fact/recommendation split), `factorsOf` reusing the decline/trafficPotential pattern keyed on lost referring domains; `logicalKey` becomes `lost_backlinks:backlinks:${domain}` (distinct from `backlink_change:…`)
- [x] T007 [US1] Register the detector in `src/server/features/intelligence/detectors/registry.ts` DETECTORS list and add the file to `DETECTOR_FILES` in `src/server/features/intelligence/intelligence-boundaries.test.ts`

**Checkpoint**: US1 independently testable — quickstart scenario 1 + 2 green

---

## Phase 4: User Story 2 - Provider failure never looks like link loss (Priority: P2)

**Goal**: Every failure/partial path is a recorded no-trigger; evidence always cites its snapshot pair

**Independent Test**: Simulate failed sync, single snapshot, stale pair, name-resolution failure (quickstart scenario 3) — zero loss findings in all cases, skips recorded with reasons

### Tests for User Story 2

- [x] T008 [P] [US2] No-trigger negatives in `lostBacklinks.test.ts`: failed snapshot sync, single-snapshot history, stale pair (beyond `freshnessDays`), name-resolution provider failure ⇒ zero findings; every skip reason recorded (mirror `detectorInputs.test.ts:213` backlink pattern and `backlinkChange.ts:86-102` gating)

### Implementation for User Story 2

- [x] T009 [US2] Verify domain-identity normalization in `lostBacklinks.ts`: comparison uses the shared domain normalization (alias/case folds never count as loss — FR-005); add a normalization fixture case (www vs bare referring domain ≠ lost) to `lostBacklinks.test.ts`

**Checkpoint**: US2 independently testable — quickstart scenario 3 green

---

## Phase 5: User Story 3 - Opportunities integrate with the existing lifecycle (Priority: P3)

**Goal**: Idempotent re-scans, single ledger events, standard lifecycle transitions, existing UI surfaces unchanged

**Independent Test**: Re-run the scan over identical inputs twice (no duplicates), move the opportunity through open → in-progress → dismissed with reason, verify events recorded once each

### Tests for User Story 3

- [x] T010 [P] [US3] Idempotency + lifecycle tests in `src/server/features/intelligence/services/materializeFinding.test.ts` (mirror the `striking_distance` lifecycle pattern at `:285-329`): same inputs re-scanned ⇒ one opportunity, one `recurred` event (never duplicate active rows — `logicalKey` uniqueness); lifecycle transitions recorded once each via the event ledger
- [x] T011 [P] [US3] Template scoring + coexistence tests in `src/server/features/intelligence/services/opportunityTemplates.test.ts`: `lost_backlinks` scoring factors produce split impact/confidence; `backlink_change` template + fixture cases byte-identical after the change (FR-008); both findings may emit from the same pair under distinct logical keys

### Implementation for User Story 3

- [x] T012 [US3] Verify the existing opportunities list/filters serve the new opportunity type with zero UI changes (`type: "backlinks"` rides existing surfaces); extend `src/server/features/intelligence/detectors/detectorTestSeeds.ts` with the lost-backlink seed pattern for future suites; verify the backlinks insight-group narrative still reads coherently (add a mapping in `insightGroups.ts` ONLY if composer output degrades — research Decision 5)

**Checkpoint**: All user stories independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T013 Run `pnpm types:check && pnpm oxlint` and fix any violations
- [X] T014 Run quickstart.md validation scenarios end-to-end (floor-gated emission, below-floor silence, failure-never-loss, idempotent re-scan + lifecycle)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies — start immediately
- **Phase 2 Foundational**: Depends on T001 — BLOCKS all user stories
- **US1 (Phase 3)**: After T002 (T003/T004 first; T005 depends on T002; T006/T007 follow T005)
- **US2 (Phase 4)**: Depends on US1's detector (T005); T008/T009 parallel
- **US3 (Phase 5)**: Depends on US1 (template + registration); T010/T011 parallel (different test files)
- **Polish (Phase 6)**: After all stories

### Parallel Opportunities

- T003, T004 parallel blocks (same new test file — sequential if conflicting)
- T008, T009 parallel (test + verify on different concerns)
- T010, T011 parallel (different test files)
- US2 and US3 fully parallel once US1 lands

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 → T002 → T003–T007 → STOP and VALIDATE (floor-gated emission with named evidence)
2. US1 alone delivers the C2a value; US2 (no-trigger safety) and US3 (lifecycle/idempotency) harden it

### Incremental Delivery

US1 (detector + emission) → US2 (failure semantics) → US3 (lifecycle integration) — each verifiable via quickstart scenarios 1–2, 3, 4.

## Notes

- No new tables, no snapshot-schema change, no UI work, no new engine — P2/P25/P50; research Decision 1 records the rejected storage alternative and its revisit condition.
- The existing `backlink_change` detector, template, and fixtures must remain byte-identical — T011 asserts it.
- All evidence is frozen at emission (P27); the recommendation comes only from the template layer.
