# Quickstart: Striking Distance Detector

**Feature**: `004-striking-distance-detector` | **Date**: 2026-09-28

Validation guide. See [spec](spec.md), [contract](contracts/detector-finding.md).

## Prerequisites

- Intelligence Engine tests green on main (`pnpm test intelligence`); fixture harness
  (`detectorTestSeeds.ts`) available.

## Scenarios

### 1. Precision/recall on labeled fixtures

1. Build fixtures: in-band above/below floor, out-of-band (pos 8, 35), band edges (10/11, 20/21).
2. Run the detector; compare emissions to labels.
3. **Expect**: exactly the qualifying set — 100% precision and recall.

### 2. Failure-mode silence

1. Fixtures: below-floor impressions, partial GSC coverage, failed rank run, rank-missing window.
2. **Expect**: zero emissions; skip reasons recorded per entity in `intelligence_run_detectors`.

### 3. Identity stability + lifecycle

1. Run detection twice over unchanged fixtures; dismiss one opportunity; re-run with re-qualifying data.
2. **Expect**: single active row + last-seen update (no duplicates); dismissed history untouched;
   re-qualification creates a linked new occurrence.

### 4. Band-constant + superset comment check

1. Assert `STRIKING_DISTANCE_MIN/MAX_POSITION` are the single band definition; helper carries the
   superset comment; registry lists exactly one `striking_distance` key.
2. **Expect**: `pnpm test registry intelligence-boundaries` green.

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test strikingDistance registry intelligence-boundaries FindingService OpportunityMaterializer
```
