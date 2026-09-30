# Research: Dashboard Stored Rollups

**Feature**: `001-dashboard-stored-rollups` | **Date**: 2026-09-28

All unknowns resolved via spec clarification (2026-09-28) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Previous-period rule

- **Decision**: Immediately-preceding window of equal day length, day-aligned, reusing one shared
  date-boundary logic across GSC, GA4, rank, and dashboard rollups.
- **Rationale**: Simplest rule guaranteeing comparable windows; single shared logic prevents per-source
  off-by-one deltas. Clarified 2026-09-28.
- **Alternatives considered**: Calendar-aligned previous period (rejected: unequal lengths distort % change);
  year-over-year (rejected: new projects have no YoY data; defer to later analytics work).

## Decision 2: Missing prior data semantics

- **Decision**: Unavailable/null delta with explicit "no prior data" / partial-coverage notes; never 0%,
  +100%, or -100%.
- **Rationale**: Constitutional failure≠zero invariant (P8/P9); percentage swings on empty baselines are
  mathematically meaningless and erode trust.
- **Alternatives considered**: Suppressing the delta silently (rejected: hides data gaps); showing raw
  division results (rejected: misleading).

## Decision 3: Extension points (verified in repo)

- **Decision**: Extend `DashboardService.getOverview` (+ `serverFunctions/dashboard.ts`); reuse
  `searchPerformanceReport.ts` (`sumSearchTotals`, `toDimensionRows`, `previousPeriod`) for GSC math.
- **Rationale**: Verified to exist in repo discovery; A0 aggregates, A1 renders — no new detection logic.
- **Alternatives considered**: New rollup service (rejected: duplicates DashboardService; violates P2).

## Decision 4: Contract-first vs B1 tables

- **Decision**: A0 codes against stored-read contracts with GA4-gated empty states; never reads B1 (002)
  tables directly.
- **Rationale**: Wave-1 parallelism requires decoupling; 002 lands independently (review correction §2.5).
- **Alternatives considered**: Blocking A0 on B1 (rejected: serializes Wave 1 unnecessarily).
