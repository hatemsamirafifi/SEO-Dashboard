# Data Model: Striking Distance Detector

**Feature**: `004-striking-distance-detector` | **Date**: 2026-09-28

No new persisted tables. Findings are transient (frozen into the run R2 artifact); opportunities reuse
the existing `opportunities` + `opportunity_events` tables unchanged.

## StrikingDistanceFinding (transient FindingDraft)

| Field | Type | Rules |
|---|---|---|
| findingKey | string | `sha256(projectId\|detectorKey\|detectorVersion\|entityKey\|periodFrom\|periodTo)` |
| detectorKey / detectorVersion | `striking_distance` / version | Registered in explicit registry |
| entityKey | string | `canonicalKeyword(query)` (+ observed URL refs in evidence) |
| position | integer | 11–20 inclusive (band constants) |
| impressions / clicks | integer | Impressions ≥ floor; both windows covered |
| periods | object | `{current: Window, previous: Window}` |
| sources / sourceRefs | object | GSC fact IDs, rank snapshot IDs |
| thresholdsApplied | object | `{minPosition: 11, maxPosition: 20, minImpressions: floor}` echoed |
| evidenceType | const | `observational` only |
| explanationFact | string | Fact-only, no recommendation, no causal verbs |
| confidenceInputs | object | Coverage, volume, persistence inputs |

## OpportunityOccurrence (existing table, this detector's usage)

| Field | Type | Rules |
|---|---|---|
| logicalKey | `striking_distance:{entityKey}` | Partial-unique active `(projectId, logicalKey) WHERE status IN (open, in_progress)` |
| status | enum | open → in_progress → completed \| dismissed (dismissal needs reason) |
| impactScore / confidenceScore | 0–100 | Existing renormalized scoring, reused |
| evidence | JSON | Frozen finding evidence + sourceRefs |
| stale | boolean | `consecutiveMisses ≥ 3` on successful executions only |

**Lifecycle**: re-detection of active key → in-place update (status preserved) + gated events;
terminal rows never reopen (recurrence → new row, `recurrenceOfId`); detector major-version bump →
old row dismissed/superseded with `supersededById` link.

## CoverageSkip (ledger row, existing `intelligence_run_detectors`)

| Field | Type | Rules |
|---|---|---|
| detectorKey | `striking_distance` | — |
| outcome | enum | `skipped` with reason: `below_impression_floor` \| `incomplete_coverage` \| `rank_unavailable` \| `source_failed` |
| entityRef | string \| null | Entity-level skips name the entity |

## Relationships

`intelligence_runs 1—* intelligence_run_detectors`; findings `*—1` artifact chunks by detectorKey;
`opportunities 1—* opportunity_events` via idempotency event keys.
