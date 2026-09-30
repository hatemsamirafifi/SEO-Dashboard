# Contract: Striking Distance Detector Finding

**Feature**: `004-striking-distance-detector` | **Date**: 2026-09-28

Detector I/O contract against the existing Intelligence Engine (`DetectorDef`, `FindingDraft`).

## Registration

- `detectorKey: "striking_distance"`, explicit registry entry (no auto-glob), version pinned into run
  input hashes. Exactly one detector owns this condition (registry uniqueness test covers it).

## Band constants (shared, single definition)

```ts
STRIKING_DISTANCE_MIN_POSITION = 11;
STRIKING_DISTANCE_MAX_POSITION = 20;
```

The existing 5–20 GSC helper is documented in code as the broader near-miss superset for
dashboard/view purposes — never as the detector definition.

## Input

Pre-fetched by `FindingService` (coverage-gated before invocation):
`{ gscWindows: {current, previous} (page/query grain), rankSnapshots?, coverageMap }`.
Required source FAILED/missing → detector skipped with reason (never invoked on failed data).

## Output (`FindingDraft[]`, observational only)

```ts
{
  entityKey: canonicalKeyword(query),   // + observed URL(s) in evidence
  metrics: { position, impressions, clicks, previousPosition? },
  periods: { current: Window, previous: Window },
  sources: ["gsc", rank?],
  sourceRefs: { gscFactIds: string[], rankSnapshotIds?: string[] },
  thresholdsApplied: { minPosition: 11, maxPosition: 20, minImpressions: FLOOR },
  correlations: [],                      // overlap-only; no causedBy field exists
  evidenceType: "observational",
  partialData: string[],                 // e.g. rank corroboration absent
  confidenceInputs: { coverage, volume, magnitude, persistence, ... },
  explanationFact: string,               // fact-only; recommendations by materializer templates
}
```

## Emission rules

Emit iff: position in [11,20] AND impressions ≥ floor AND both windows fully covered AND required
inputs successful. Otherwise skip with reason (`below_impression_floor | incomplete_coverage |
rank_unavailable | source_failed`) recorded in `intelligence_run_detectors`. Multi-URL queries: entity
is per query; evidence names observed URLs; wording stays "potential" where split-attribution applies.
