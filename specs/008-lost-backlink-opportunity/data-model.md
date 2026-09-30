# Data Model: Lost-Backlink Opportunity

**Feature**: `008-lost-backlink-opportunity` | **Date**: 2026-09-30

No new persisted tables. Models below are detector-input, evidence, and opportunity contracts; sources are the existing `backlink_snapshots` rows and the cached referring-domains path.

## LostBacklinksInput

Pre-fetched detector input (never a live provider read at detect time).

| Field                              | Type             | Rules                                                                                                              |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| domain                             | string           | Project's own domain (from the stored snapshots; stored per row so domain changes don't rewrite history)           |
| before / after                     | BacklinkTotals   | Aggregate totals of the two newest snapshots (newest first)                                                        |
| beforeCapturedAt / afterCapturedAt | string (ISO)     | Snapshot capture times; frozen into evidence                                                                       |
| lostDomains                        | string[] \| null | Bounded top-N lost-domain names, resolved only when the floor triggers; null = unresolved (no-trigger, never loss) |
| thresholds                         | object           | Echoed applied thresholds (floor, minSnapshots, freshnessDays)                                                     |

## BacklinkSnapshotPair

| Field              | Type    | Rules                                                                                    |
| ------------------ | ------- | ---------------------------------------------------------------------------------------- |
| beforeId / afterId | number  | Snapshot row IDs (autoincrement order = recency; immune to timestamp format differences) |
| freshness          | boolean | Newest snapshot within `freshnessDays` (default 30); stale ⇒ no-trigger                  |

## LostDomainEvidence

Frozen at emission; verifiable later without re-deriving.

| Field                     | Type         | Rules                                                                                               |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| lostDomains               | string[]     | Bounded top-N named lost domains (normalized domain identity; alias/case folds never count as loss) |
| lostReferringDomains      | number       | Aggregate lost count; the floor unit (≥ 3 default)                                                  |
| lostBacklinks             | number       | Aggregate lost backlink count (context, never the floor unit)                                       |
| snapshotFrom / snapshotTo | string (ISO) | Compared capture timestamps                                                                         |
| coverage                  | enum         | full \| partial \| insufficient (insufficient ⇒ no-trigger, reason recorded)                        |

**Validation**: `lostReferringDomains < 3` (default floor) ⟹ no emission; unknown (`null`) totals ⟹ no emission (unknown ≠ 0).

## LostBacklinkOpportunity

Standard opportunity row via the existing materializer: `logicalKey = lost_backlinks:backlinks:${domain}` (distinct from `backlink_change:…`), `type = "backlinks"` (existing filters apply), impact/confidence separate, lifecycle open → in_progress → completed/dismissed with reason, events idempotent per `(occurrence, type, scan, contentHash)`.

## Relationships

`BacklinkSnapshotPair 1—1 LostBacklinksInput`; `LostBacklinksInput 0—1 LostBacklinkOpportunity` (floor-gated); `LostBacklinkOpportunity 1—* OpportunityEvent` (ledger). The aggregate `backlink_change` finding coexists from the same pair under its own logical key.
