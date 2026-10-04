# Contract: Conversion-Drop & Engagement-Drop Detector Findings

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
**Model**: existing `DetectorDef` / `FindingDraft` (`src/server/features/intelligence/detectors/types.ts`)
— the 004 contract is the structural precedent; this contract follows it verbatim in shape.

## Registration (both detectors)

- Explicit `DETECTORS` entries (no auto-glob); `detectorKey` uniqueness covered by the registry test;
  versions pinned into run input hashes.
- `inputs.ts` dispatcher gains both cases; fetchers follow the pre-fetched-inputs rule (never live
  repository reads inside `detect`).
- `THRESHOLD_VERSION` 2 → 3 with the new `DEFAULT_DETECTOR_THRESHOLDS` entries (header-comment
  precedent for recording the bump reason in-code).

## `conversion_drop` (C2b)

- `detectorKey: "conversion_drop"`, `version: 1`, `requiredSources: ["ga4"]`,
  `optionalCorroborators: []` (single-source by design — like `ga4_organic_change`,
  GSC raises composed insight confidence, never finding inputs).
- **Entity**: project goal (site-level) — `entityKey = "goal:{goalId}"`. Per-goal, not
  per-page: the stored event grains carry no page dimension (research R5), so page×goal
  findings would require fabricated joins. This matches the existing site-level
  `ga4_organic_change` precedent (`pageOf`/`keywordOf` null).
- **Scope**: one finding per active project goal; archived goals are never evaluated.
- **Emit iff**: goal conversions current vs previous (equivalent windows, ≥28d, ≥0.8 coverage each)
  fall by ≥ `declineRatio` (default 0.3) AND baseline-window conversions ≥ `minEventsPerWindow`
  (default 10 — absolute floor on the baseline so 12→3 emits but 2→0 never does).
- **Skip reasons** (recorded `skipped` in `intelligence_run_detectors`): `no_ga4_connection`,
  `no_goal_defined`, `events_coverage_below_ratio`, `below_event_floor`, `ga4_failed` — never invoked
  on failed sources (G9/P28).

## `engagement_drop` (C2c)

- `detectorKey: "engagement_drop"`, `version: 1`, `requiredSources: ["ga4"]`,
  `optionalCorroborators: ["rank"]` (GSC page rows feed join presence/coverage
  context only — corroboration is the rank-held gate).
- **Entity**: canonical page; single finding per page (not per goal).
- **Emit iff**: engagement rate (engagedSessions/sessions, ratio-of-sums per window) drops ≥
  `declineRatio` (default 0.25) AND sessions floor met (`minSessionsPerWindow` 100 per window) AND
  rank-held corroboration (`rankHoldRequired`): when rank data present, `rankWorsened === false`;
  when rank absent, emit with `partialData: ["rank_corroboration_absent"]` and capped confidence.
- **Skip reasons**: `no_ga4_connection`, `landing_coverage_below_ratio`, `below_session_floor`,
  `rank_worsened` (the "while ranking held" gate — rank drop means the ranking_drop detector owns it,
  not this one), `ga4_failed`.

## Evidence shape (both, `FindingDraft.evidence`)

```ts
{
  metrics: {
    // conversion_drop: goalName (frozen snapshot), goalId,
    //   conversionsBefore, conversionsAfter, changeRatio, windowDays
    // engagement_drop: rateBefore, rateAfter, changeRatio,
    //   engagedSessionsBefore/After, sessionsBefore/After, windowDays
  },
  periods: { from, to },
  sources: ["ga4", ...corroborators present],
  sourceRefs: { ga4Keys: string[], rankSnapshotIds?: ... , gscFactIds?: ... },
  thresholdsApplied: { /* every injected threshold value, echoed (file-header rule) */ },
  correlations: [],                       // overlap-only; no causedBy exists
  evidenceType: "observational",
  partialData: string[],
  confidenceInputs: { coverage, volume, magnitude, persistence },
}
```

`explanationFact` is fact-only observational prose (no recommendation, no causal verbs — P27/P46);
goal name is snapshotted into evidence so archived/renamed goals never corrupt history.

## Materialization (existing pipeline, no second model — G3/P25)

- `OPPORTUNITY_TEMPLATES.conversion_drop` → type `ga4_conversion`; `factorsOf` activates
  `conversionSignal` (first real value for that factor — the documented hook in the templates header);
  `decline` uses `declineOf(changeRatio)`; `trafficPotential` from page sessions.
- `OPPORTUNITY_TEMPLATES.engagement_drop` → type `ga4_engagement`.
- Impact/confidence stay separate (`opportunities.impactScore`/`confidenceScore` columns, P26);
  idempotent emission via the existing `logicalKey` + `eventKey` unique constraints (re-scan over the
  same windows emits nothing new).

## Coverage gating (G2/G9)

Fetchers throw `InsufficientCoverageError` (recorded as `skipped`) when: no GA4 connection
(`Ga4ConnectionRepository.getByProjectId` precedent from `ga4OrganicChange`), no SUCCESS_* grain
coverage, or window coverage below `minCoverageRatio` — the windows anchor at the latest covered date,
never wall clock (existing `splitWindows` precedent).