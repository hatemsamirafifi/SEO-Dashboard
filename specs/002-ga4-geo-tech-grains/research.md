# Research: GA4 Geo and Technology Grains

**Feature**: `002-ga4-geo-tech-grains` | **Date**: 2026-09-28

All unknowns resolved via spec clarification (2026-09-28) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Tail handling under cardinality bounds

- **Decision**: Deterministic "(other)" row per grain + truncation metadata (isTruncated flag,
  retained/omitted counts when reliably known, other-row presence). Totals stay exact.
- **Rationale**: Clarified 2026-09-28; preserves aggregates, bounds storage/sync, makes truncation visible.
  Never fabricate omitted counts GA4 doesn't provide.
- **Alternatives considered**: Dropping the tail (rejected: silent data loss looks like zero traffic);
  unbounded storage (rejected: quota/sync-time blowup at 10x cardinality).

## Decision 2: Grain pattern reuse

- **Decision**: Mirror `ga4_daily_acquisition` table shape (canonical NN dims + raw audit cols, deterministic
  UNIQUE, project/date indexes), `ga4_sync_coverage` state machine, and `Ga4SyncService` 7-day chunking.
- **Rationale**: Verified existing pattern in `src/db/ga4.schema.ts` + `Ga4SyncService.ts`; consistency
  reduces review surface and parity risk.
- **Alternatives considered**: Wide single table for geo+tech (rejected: sparse rows, diverging indexes,
  harder retention).

## Decision 3: "(not set)" sentinel

- **Decision**: Reuse `canonicalGa4Dimension` sentinel (`shared/ga4.ts`) for missing dimensions so NULL
  behavior is identical on D1/PG.
- **Rationale**: Existing, parity-tested convention; keeps uniqueness composites NOT NULL.
- **Alternatives considered**: Nullable dims (rejected: D1/PG NULL-uniqueness divergence).

## Decision 4: Numeric bounds (backfill window, top-N)

- **Decision**: Mechanism fixed in spec (bounded + surfaced); concrete numbers set during planning against
  live-calibration notes (short initial backfill, per-grain top-N) behind existing config.
- **Rationale**: Numbers need production measurement (risk register); mechanism is the testable contract.
- **Alternatives considered**: Hardcoding bounds in spec (rejected: premature without live data).
