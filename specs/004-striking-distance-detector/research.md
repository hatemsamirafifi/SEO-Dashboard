# Research: Striking Distance Detector

**Feature**: `004-striking-distance-detector` | **Date**: 2026-09-28

All unknowns resolved via spec clarification (2026-09-28) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Band definition

- **Decision**: Detector band 11–20 inclusive via shared band constants
  (`STRIKING_DISTANCE_MIN_POSITION = 11`, `STRIKING_DISTANCE_MAX_POSITION = 20`); existing 5–20 GSC
  helper retained for dashboard/near-miss views with an explicit superset comment.
- **Rationale**: Clarified 2026-09-28; keeps detector focused on page-one-adjacent quick wins without
  changing existing dashboard behavior; one documented relationship, never two silent meanings.
- **Alternatives considered**: Narrowing the helper to 11–20 (rejected: changes existing UI unnecessarily);
  widening the detector to 5–20 (rejected: page-one keywords are not quick wins).

## Decision 2: Detector pattern

- **Decision**: Follow `lowCtrQuery.ts` structure (pure `detect(ctx, input)`, injected thresholds echoed in
  evidence, `FindingDraft[]` output) + registry entry + `detectorVersions` pinning.
- **Rationale**: Verified existing convention; registry test enforces one-key-per-condition.
- **Alternatives considered**: Standalone service outside registry (rejected: second detection system, P25).

## Decision 3: Input pairing

- **Decision**: GSC page/query grain (positions, impressions over covered windows) with rank-snapshot
  corroboration where available; rank-missing = unavailable input (skip), never position zero.
- **Rationale**: Matches per-detector corroboration policy family; failure≠zero (P28).
- **Alternatives considered**: GSC-only without rank (weaker confidence); rank-only (misses impression floor).

## Decision 4: Impressions floor placement

- **Decision**: Floor is an injected threshold echoed in `thresholdsApplied`; concrete value set in planning
  from near-miss distribution reasoning, logged for post-ship calibration.
- **Rationale**: Same treatment as existing detector thresholds; avoids magic numbers while shipping a
  reasoned prior.
- **Alternatives considered**: Fixed constant in spec (rejected: needs production calibration loop).
