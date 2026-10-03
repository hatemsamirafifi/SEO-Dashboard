# Quickstart: GA4 Joins, Goals, GA4-Backed Detectors, and Opportunities Depth

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
Runnable validation scenarios proving the feature end-to-end. Implementation steps live in
`tasks.md` (created by `/speckit.tasks`); contracts live in [contracts/](./contracts/), schema in
[data-model.md](../data-model.md).

## Prerequisites

- Node 24, pnpm 10; local dev DB applied (`pnpm db:migrate:local` for D1; PG equivalent for parity runs).
- A project with GA4 connected and synced (existing flow) — or seeded `ga4_daily_events` /
  `ga4_daily_landing_pages` rows per the existing test fixtures (`Ga4SyncRepository.analytics.test.ts`
  seeding helpers are the precedent).
- GSC and rank-tracking grains seeded for join scenarios (fixture helpers exist in
  `detectorTestSeeds.ts`).

## Setup

```powershell
pnpm install
pnpm db:migrate:local          # applies the new ga4_project_goals migration
pnpm dev                       # local dev server (or pnpm dev:agents)
```

## Validation scenarios

### V1 — Goal CRUD + goal-scoped analytics (contract: goals-api.md)

1. Create a goal: call the goal create flow with `name: "Newsletter signup"`,
   `eventName: "signup_completed"`.
2. Expected: goal appears in the list; a second goal with the same name while active is rejected;
   the 21st active goal is rejected with the cap error.
3. Filter an analytics conversions view by `goalId` over seeded event rows.
4. Expected: conversion figures equal the seeded `ga4_daily_events` sums for that event over
   SUCCESS_*-covered dates; a goal whose event has zero rows renders **no-data**, never zero; an
   unknown/archived `goalId` errors, never silently empties.
5. Archive the goal; expected: list (active-only) no longer includes it, `includeArchived: true` does,
   update on the archived goal is rejected.

### V2 — Organic page join (contract: organic-join.md)

1. Seed GA4 landing rows, GSC page rows, and rank rows for overlapping canonical URLs (include the 006
   must-join and must-not-join fixture pairs).
2. Run the join through the organic view / detector fetcher path.
3. Expected: one row per canonical page; must-join variants collapse; must-not-join variants stay
   distinct; GSC-only pages show `ga4` absent with null metrics (never zeros); a GA4 page with
   sessions=0 shows `ga4Engagement: null` (undefined rate), not 0; shuffling input order yields
   identical output.

### V3 — Detectors (contract: detector-findings.md)

1. Define a goal (V1); seed two 28-day windows of event rows: current window with a ≥30% conversion
   drop vs previous, meeting the 10-conversion floor.
2. Run an intelligence scan.
3. Expected: exactly one `ga4_conversion` opportunity; evidence names the page, goal (frozen name),
   both windows, delta, and every applied threshold; impact and confidence are separate values.
4. Seed an engagement scenario: engagement-rate drop ≥25% with ≥100 sessions per window and rank
   held → exactly one `ga4_engagement` opportunity; with rank data absent → still emitted with
   `partialData: ["rank_corroboration_absent"]` and visibly lower confidence.
5. Negative suite: GA4 disconnected / sync failed / coverage < 0.8 / floors unmet / rank worsened →
   zero opportunities from both detectors, and every skipped evaluation is recorded with its skip
   reason.
6. Re-run the scan over identical windows → zero new opportunities, zero duplicate ledger events.

### V4 — Opportunities filters + evidence detail (contract: opportunities-filters.md)

1. Seed (or scan into existence) opportunities of several types/pages/priorities/sources.
2. Apply composed filters: type × status, page × type, keyword × priority, source × status.
3. Expected: correct result sets; a no-match combination shows the explicit `filtered-empty` state
   (distinct from the project-empty explainer); a value-less facet is disabled, not fake-empty.
4. Open any opportunity's detail.
5. Expected: frozen evidence (metrics, periods, sources, thresholdsApplied, partialData) renders
   exactly as stored; the V3 opportunity's `ga4Keys` source refs render alongside gsc/rank refs.

## Verification commands

```powershell
# Targeted suites (extend the existing files; run them directly):
pnpm vitest run src/db/schema-parity.test.ts src/db/ga4Migration.test.ts
pnpm vitest run src/server/features/intelligence
pnpm vitest run src/server/features/ga4
pnpm vitest run src/client/features/opportunities

# Quality gates (P45):
pnpm types:check
pnpm lint

# E2E (goal CRUD → analytics filter → opportunity triage):
pnpm test:e2e
```

## Expected outcomes (maps to spec SC-001..SC-006)

- Goal-filtered numbers match seeded rows exactly; any aggregate summing users fails the suite (SC-001).
- Join returns 100% available metrics, zero invented, all unavailability explicit (SC-002).
- All failure modes emit zero opportunities with recorded skip reasons; valid windows emit exactly one
  opportunity per condition (SC-003); re-scans are idempotent (SC-004).
- Filter composition correct with explicit empty states; evidence detail frozen for every type
  (SC-005).
- Parity green for `ga4_project_goals`; typecheck + lint green; boundary tests prove single
  canonicalizer/join/engine (SC-006).