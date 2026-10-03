---
description: "Task list for spec 011 — SERP Features Normalization + Dashboard Intelligence UI"
---

# Tasks: SERP Features Normalization + Dashboard Intelligence UI

**Input**: Design documents from `/specs/011-serp-features-ui/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: This repository is constitutionally TDD (P43/P44 — unit/service/UI/E2E mandatory categories). Test
tasks are therefore included and MUST be written first (failing) before the implementation task in the same
story phase.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- File paths are relative to repository root

## Path Conventions

- Server SERP feature: `src/server/features/serp/`
- Shared contracts: `src/shared/intelligence.ts`
- Dashboard service: `src/server/features/dashboard/services/`
- Client surfaces: `src/client/features/{keywords,rank-tracking,serp,dashboard}/`
- E2E: `e2e/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Feature skeleton files and shared label vocabulary before any story work

- [X] T001 [P] Create `src/server/features/serp/featurePresentation.ts` skeleton exporting the frozen
  `SerpFeatureSet` type re-export plus an empty `toSerpFeatureBlocks(features: SerpFeatureSet): SerpFeatureBlock[]`
  signature and the `SerpFeatureBlock` type (fields per data-model.md §2: `family`, `label`, `order`, `items`,
  `placement`), building cleanly with no implementation
- [X] T002 [P] Create `src/client/features/serp/` directory with a stub `SerpResultCards.tsx` exporting an
  empty named component, so story phases can fill it without path churn

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The two shared contracts every story consumes. **CRITICAL**: No user story work can begin until
this phase is complete.

### Tests for Foundational (write FIRST, must FAIL)

- [X] T003 [P] Extend `src/server/features/serp/serpBoundaries.test.ts` with an import-ban guard asserting no
  file under `src/client/` imports provider JSON shapes (`dataforseo/serp`) or re-declares SERP feature family
  keys as string literal arrays outside `src/server/features/serp/types.ts` +
  `src/server/features/serp/featurePresentation.ts`
- [X] T004 [P] Add failing state-derivation input-shape tests to `src/shared/intelligence.test.ts` for the
  extended `mapStoredSectionState` input fields (`loading`, `permissionDenied`, `readFailed`, `stale`,
  `hasItems`) per data-model.md §3 precedence rows 1–6 and 8–9 (currently absent — tests fail)

### Implementation for Foundational

- [X] T005 Implement the extended `MapStoredSectionStateInput` (adds `loading?: boolean`,
  `permissionDenied?: boolean`, `readFailed?: boolean`, `hasItems?: boolean | null`, `stale?: boolean` — all
  defaulting false/null) and rewrite `mapStoredSectionState` in `src/shared/intelligence.ts` to apply the
  fixed precedence chain verbatim from data-model.md §3: `loading → not_connected → permission_failed →
  sync_running → sync_failed → api_failed → no_data → empty → stale → partial → ready` (first match wins);
  export a documented `SECTION_STATE_PRECEDENCE` const array containing exactly those 11 state strings in
  precedence order
- [X] T006 Add a generated state-matrix parametrized test in `src/shared/intelligence.test.ts` iterating every
  combination class from contracts/dashboard-sections.md §A2 state matrix (loading; not connected; permission
  failed; sync running; sync failed; read failed; no data; empty list; stale; partial; ready) and asserting:
  (a) each input class resolves to exactly one expected state, (b) no input combination with a failure flag
  (`permissionDenied`/`syncFailed`/`readFailed`) can ever yield `ready`/`empty`/`no_data`/`partial`/`stale`
- [X] T007 Create the shared feature-label table in `src/server/features/serp/featurePresentation.ts`:
  `SERP_FAMILY_LABELS` mapping the ten frozen families to labels verbatim from
  contracts/serp-feature-presentation.md §consolidation table (`featuredResult`→"Featured snippet",
  `peopleAlsoAsk`→"People Also Ask", `relatedSearches`→"Related searches", `localPack`→"Local pack",
  `images`→"Images", `videos`→"Videos", `shopping`→"Shopping", `news`→"News", `knowledgeGraph`→"Knowledge
  panel", `sitelinks`→"Sitelinks"), plus `SERP_FAMILY_ORDER` const with the contract order
  (`featuredResult → localPack → peopleAlsoAsk → images → videos → shopping → news → knowledgeGraph →
  sitelinks → relatedSearches`)

**Checkpoint**: Foundational contracts green (T003–T004 fail→pass via T005–T007); story phases may start.

---

## Phase 3: User Story 1 – Normalized SERP features on keyword/result views (Priority: P1) 🎯 MVP

**Goal**: Every stored SERP renders exactly its observed feature families, normalized through one derivation,
with correct placement semantics and zero fabrication.

**Independent Test**: Seed stored SERP snapshots containing a known mix of feature families (including one
snapshot with zero features), load the keyword SERP analysis surface, assert exactly the stored families
render with labels/placement per contract and organic positions are unaltered — with rank-tracking chips
disabled, proving the derivation alone carries the story.

### Tests for User Story 1 (write FIRST, must FAIL)

- [X] T008 [P] [US1] Create `src/server/features/serp/featurePresentation.test.ts` covering
  contracts/serp-feature-presentation.md guarantees: (a) fixture with all ten families → ten blocks in
  `SERP_FAMILY_ORDER`, (b) fixture with only `peopleAlsoAsk` + `localPack` → exactly two blocks, absent
  families produce none (fabrication guard), (c) block `items` are deep-equal to the snapshot's stored items
  (pass-through fidelity V2), (d) exact-duplicate PAA items are swept with a logged note, (e) a defensive
  unknown-key object cast is ignored + logged, not thrown (FR-005), (f) PAA block exposes stored `placement`
  values and `placement: null` fallback when absent (V3)
- [X] T009 [P] [US1] Add failing component tests in `src/client/features/keywords/components/SerpFeatureBlocks.test.ts (renamed: vitest includes only \*.test.ts)`
  asserting: rendering a seeded block list shows each family label once; a `SerpSnapshot` with zero features
  renders no feature section at all (no placeholder card); PAA items render as expandable questions; absent
  item fields (`rating`, `price`, `address`) render nothing rather than "—"/`0`
- [X] T010 [P] [US1] Add failing placement assertions in
  `src/client/features/keywords/components/SerpFeatureBlocks.test.ts (renamed: vitest includes only \*.test.ts)`: organic result rows keep their stored
  `position` numbering verbatim when a PAA block is present (assert consecutive integers from the fixture in
  the rendered `#` cells), and the PAA block with `placement: 3` renders annotated as appearing alongside
  results around position 3, using observational wording

### Implementation for User Story 1

- [X] T011 [US1] Implement `toSerpFeatureBlocks` in `src/server/features/serp/featurePresentation.ts`
  per contracts/serp-feature-presentation.md: iterate keys present on the input object (never a fixed probe
  list), one block per present family with contract order + labels from T007, pass-through items with a
  defensive exact-duplicate sweep (`console.warn`-logged), unknown-key sweep logged and ignored, PAA
  `placement` taken from the first item carrying a non-null placement else `null`
- [X] T012 [P] [US1] Create `src/client/features/keywords/components/SerpFeatureBlocks.tsx` rendering
  `SerpFeatureBlock[]`: per-family sections with contract labels; PAA as expandable question list; local pack
  as compact rows (title, address/rating when present — never a fabricated map); shopping items show `price`
  only when present; news items show `sourceName`/`publishedAt` only when present
- [X] T013 [US1] Wire `SerpAnalysisCard.tsx` to derive blocks via `toSerpFeatureBlocks` and render
  `SerpFeatureBlocks` under the organic results table; PAA renders adjacent to the list with placement
  annotation per contracts §placement rule — organic table rows keep stored positions untouched
- [X] T014 [US1] Consolidate legacy rank-tracking feature chips in
  `src/client/features/rank-tracking/RankTrackingTableParts.tsx`: delete local `FEATURE_SHORT_LABELS`/
  `FEATURE_TOOLTIPS` maps and map incoming legacy chip keys onto frozen families via a single exported
  adapter (`normalizeLegacyFeatureKey`: `featured_snippet`→`featuredResult`, `knowledge_panel`→
  `knowledgeGraph`, `top_stories`→`news`, `video`→`videos`, `people_also_ask`→`peopleAlsoAsk`,
  `local_pack`→`localPack`, `images`→`images`, `shopping`→`shopping`; `ai_overview` maps to nothing and is
  dropped); tooltips read from `SERP_FAMILY_LABELS`; update `RankTrackingTableParts.test.ts` accordingly
- [X] T015 [US1] Make T003 boundary test pass: remove any remaining raw-provider or duplicate family-key
  declarations flagged by the guard (expected: only the consolidated maps from T014)

**Checkpoint**: `pnpm vitest run src/server/features/serp src/client/features/keywords
src/client/features/rank-tracking` green; US1 independently demoable.

---

## Phase 4: User Story 2 – Mobile SERP card view (Priority: P2)

**Goal**: Below the `md` (768px) breakpoint the SERP surface renders position/result/summary cards with
metrics behind expansion and feature blocks in the same card rhythm, with zero horizontal overflow.

**Independent Test**: Render a seeded SERP (with PAA + local pack + a 10-item PAA list fixture) at 390×844
via component tests and Playwright; assert `document.scrollWidth <= innerWidth`, every card shows
position/result/summary without expansion, metrics appear only after expanding `serp-card-expand`, long PAA
list stays bounded — runnable without any dashboard or state-model work.

### Tests for User Story 2 (write FIRST, must FAIL)

- [X] T016 [P] [US2] Create `src/client/features/serp/SerpResultCards.test.tsx` covering
  contracts/serp-mobile-card-view.md anatomy: position/result/summary always visible; metrics nodes absent
  until disclosure toggled; title two-line truncation class and URL single-line ellipsis applied; feature
  chips read from the same `SerpFeatureBlock[]` derivation (adapter from T014 reused)
- [X] T017 [P] [US2] Create `e2e/serp-features-mobile.spec.ts` (Playwright, viewport 390×844) asserting:
  no horizontal overflow on `data-testid="serp-results-mobile"`; PAA feature block renders as its own card in
  block order (not inside the numbered result list); expanding one card does not shift a sibling card's
  bounding-box Y; a 10-item PAA fixture card height stays within a bounded max; enrichment `failed`/`unavailable`
  annotation appears on metric areas while result + feature cards still render (FR-006, seeded via the 007
  status contract)

### Implementation for User Story 2

- [X] T018 [US2] Implement `src/client/features/serp/SerpResultCards.tsx`: compose
  `SerpResultCardRow` per data-model.md §4 from stored snapshot rows + derived blocks; per-card
  `<details>`-style expansion for metrics honoring the 007 status contract (`failed`/`unavailable` render an
  explicit annotation, never zeroed values); interleave feature block cards at placement slots per the PAA
  rule (placement-honored, post-top-results fallback) with `data-testid="serp-feature-block-{family}"`;
  long PAA lists get capped height with internal scroll
- [X] T019 [US2] Add responsive switching to `SerpAnalysisCard.tsx`: below `md` render `SerpResultCards`
  wrapped in `data-testid="serp-results-mobile"`; at/above `md` keep the existing dense table unchanged;
  single data fetch feeds both layouts (no parallel read path)

**Checkpoint**: T016/T017 green; US2 demoable independently on any seeded keyword SERP.

---

## Phase 5: User Story 3 – Dashboard intelligence sections on stored rollups (Priority: P3)

**Goal**: All eight A1 sections provably read stored rollups, match detail-view numbers, and render honest
not-connected/no-data states — including goal-aware conversions naming from spec 010.

**Independent Test**: Seed stored rollups/findings + one GA4 goal; load Dashboard; assert each section's
totals equal fixture values and a disconnected project's sections render not-connected — runnable with the
SERP surfaces untouched.

### Tests for User Story 3 (write FIRST, must FAIL)

- [X] T020 [P] [US3] Add failing assertions in
  `src/server/features/dashboard/services/DashboardService.test.ts`: seeded rollup fixtures → each of the
  eight sections' metrics deep-equal the stored rollup values for the same project + 28-day window (SC-004);
  a `conversions` section with a seeded spec-010 project goal lists the goal's stored name; a project with
  no GA4 connection yields `trafficEngagement` + `conversions` in `not_connected` with `metrics: null`
- [X] T021 [P] [US3] Add failing render tests in
  `src/client/features/dashboard/DashboardCards.test.tsx`: sections render metrics only when the section
  state permits data (`ready`/`partial`/`stale`); `not_connected` renders the connect CTA; `no_data` and
  `empty` render distinct messages (never zeroed numbers)

### Implementation for User Story 3

- [X] T022 [US3] In `DashboardService.ts` extend `getConversionsSection` to read spec-010 project goals
  (stored names) and list goal-scoped conversion rows by name when goals exist, falling back to the existing
  keyEvents list otherwise — stored reads only, no new provider calls
- [X] T023 [US3] Create a shared `SectionStateShell` in `src/client/features/dashboard/cardParts.tsx`
  rendering loading skeleton / failure + retry button / empty message / not-connected CTA and passing
  `metrics` to children only for `ready`/`partial`/`stale` (with a freshness note when `stale`, sourced
  from `coverage.freshness`); route `DashboardCards.tsx` sections through it, deleting bespoke per-section
  error branches

**Checkpoint**: T020/T021 green; Dashboard truthful states verified independently.

---

## Phase 6: User Story 4 – Unified 11-state section model (Priority: P3)

**Goal**: Every dashboard section derives state exclusively through the foundational mapper (T005) — no
direct `state:` assignments remain — with the full state matrix locked by tests and failure permanently
distinct from empty.

**Independent Test**: Grep-guard + adapter tests prove only `mapStoredSectionState` sets section state;
the generated matrix covers all 11 scenario classes for all 8 sections; runnable without SERP surfaces.

### Tests for User Story 4 (write FIRST, must FAIL)

- [X] T024 [P] [US4] Add per-section adapter tests in
  `src/server/features/dashboard/services/DashboardService.test.ts` (or
  `DashboardService.sections.test.ts`): for each of the eight sections, drive the documented input-obligation
  rows from data-model.md §3 table (e.g. technicalHealth: `stale` beyond 30d; backlinks: missing snapshot →
  obligation state; opportunities: zero open → `empty`; searchVisibility: zero tracked keywords → `empty`)
  and assert the resolved state matches
- [X] T025 [P] [US4] Add failing grep-guard test (co-locate in
  `src/server/features/dashboard/services/DashboardService.test.ts` or a boundaries test) asserting
  `DashboardService.ts` contains no `state:` literal assignments outside the `mapStoredSectionState` call
  and the `safeSection` `api_failed` fallback — i.e. zero remaining hand-rolled derivations
  (`previousCovered ? "ready" : "partial"`, `stale ? "stale" : "ready"`, `items.length === 0 ? "empty" : "ready"`, etc.)
- [X] T026 [P] [US4] Create `e2e/dashboard-states.spec.ts` (Playwright) spot-checking the three
  safety-critical renders per contracts/dashboard-sections.md §A2: `api_failed` shows retry affordance and
  no zeroed metrics; `not_connected` shows connect CTA; `empty` opportunities shows the empty message —
  distinct copy for each (failure ≠ empty assertion included)

### Implementation for User Story 4

- [X] T027 [US4] Route all eight `get*Section` functions in `DashboardService.ts` through
  `mapStoredSectionState`: compute `loading`/`permissionDenied`/`readFailed`/`syncRunning`/`syncFailed`/
  `hasCurrent`/`hasPrevious`/`hasItems`/`stale` flags from each section's stored reads per the data-model.md
  §3 obligations table (technicalHealth passes `stale` = audit older than 30d; list sections set `hasItems`
  = `items.length > 0`; `searchVisibility` treats "not configured" as `connected: false`); delete every
  direct `state:` assignment outside the mapper and `safeSection`
- [X] T028 [US4] Verify `safeSection` exception path still maps to `api_failed` through the same state
  vocabulary (adjust only if the mapper's `readFailed` input makes the catch-block state derivable instead
  of hardcoded) and update `DashboardService.test.ts` existing expectations to the unified derivations —
  previously-green suites must stay green

**Checkpoint**: T024/T025/T026 green; `pnpm vitest run src/shared/intelligence.test.ts
src/server/features/dashboard` fully green including pre-existing suites.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T029 [P] Run quickstart.md validations V1–V4 and record outcomes in the spec directory (no new
  artifacts — verify only)
- [X] T030 Run full gates: `pnpm types:check`, `pnpm oxlint` on touched files,
  `pnpm vitest run src/server/features/serp src/shared src/server/features/dashboard
  src/client/features/serp src/client/features/keywords src/client/features/rank-tracking
  src/client/features/dashboard`; confirm `src/db/schema-parity.test.ts` untouched-green (no schema changes)
- [X] T031 [P] Verify truthfulness sweep (P46): grep new/changed UI copy for causal verbs ("caused",
  "boosted", "will improve") in feature labels, PAA annotations, and section-state messages — observational
  wording only

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Phase 1 — **BLOCKS** all user stories (shared labels + unified mapper are consumed by US1/US3/US4)
- **US1 (Phase 3)**: after Foundational — depends on T005–T007 (label table + boundary guard plumbing)
- **US2 (Phase 4)**: after Foundational + US1's derivation (T011) — reuses `toSerpFeatureBlocks` + chip adapter (T014)
- **US3 (Phase 5)**: after Foundational — `SectionStateShell` (T023) builds on T005 states; independent of SERP stories
- **US4 (Phase 6)**: after Foundational + US3 shell — reroutes service derivations; US3's shell must exist for consistent rendering
- **Polish (Phase 7)**: after all completed stories

### User Story Dependencies

- **User Story 1 (P1)**: no story dependencies — MVP
- **User Story 2 (P2)**: depends on US1 derivation module only (data dependency, not blockers-by-implementation of UI)
- **User Story 3 (P3)**: no US1/US2 dependency
- **User Story 4 (P3)**: depends on US3's shared shell for the render contract; service-side rerouting is otherwise independent

### Parallel Opportunities

- Phase 1: T001 ∥ T002
- Phase 2 tests: T003 ∥ T004 (then T005 → T006 ∥ T007)
- US1 tests: T008 ∥ T009 ∥ T010; then T011 → (T012 ∥ T014) → T013, T015
- US2 tests: T016 ∥ T017
- US3 tests: T020 ∥ T021
- US4 tests: T024 ∥ T025 ∥ T026 (Playwright file independent of unit files)
- Stories: US1 and US3 can run concurrently after Foundational (disjoint files)

## Parallel Example: User Story 1

```bash
# Launch US1 test tasks together (all fail first):
Task: "Create featurePresentation.test.ts with ten-family fixture + fabrication guard + pass-through checks"
Task: "Create SerpFeatureBlocks.test.ts (renamed: vitest includes only \*.test.ts) absent-safe rendering assertions"
Task: "Add PAA placement + organic-position-preservation assertions"

# Then implementation:
Task: "Implement toSerpFeatureBlocks in src/server/features/serp/featurePresentation.ts"
Task: "Create SerpFeatureBlocks.tsx per-family renderers"
Task: "Consolidate RankTrackingTableParts chips onto frozen families"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 + Phase 2 (T001–T007) — shared contracts green
2. Phase 3 (T008–T015) — normalized features visible on keyword SERP surface
3. **STOP and VALIDATE**: run US1 independent test; demo

### Incremental Delivery

1. Foundation → US1 (features surface; MVP) → validate
2. US2 (mobile card view) → validate
3. US3 (dashboard section truthfulness) → validate
4. US4 (11-state unification) → validate → full state matrix locked
5. Polish/gates → merge

### Notes

- TDD order within each story: test tasks (fail) → implementation (pass) — P43
- `ai_overview` is deliberately excluded: not in the frozen ten-family contract (T014 drops it from chips)
- Any discovered need for a new table/migration is OUT OF SCOPE per spec Assumptions — raise back to plan gates instead of adding
