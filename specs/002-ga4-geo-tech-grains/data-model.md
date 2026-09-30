# Data Model: GA4 Geo and Technology Grains

**Feature**: `002-ga4-geo-tech-grains` | **Date**: 2026-09-28

New persisted tables (D1 + PG mirror, additive migration). Conventions: `id TEXT PK`, ISO-text timestamps,
project-leading indexes, JSON TEXT/jsonb for truncation meta, writes via `executeInBatches`.

## Ga4DailyGeo (`ga4_daily_geo`)

One row per (project, property, date, country).

| Field | Type | Rules |
|---|---|---|
| id | text PK | Random ID |
| projectId | text FK→projects cascade | Scoping |
| propertyId | text | GA4 property |
| date | text (YYYY-MM-DD) | Day grain |
| country | text NOT NULL | Canonical dim; `'(not set)'` sentinel; `'(other)'` tail row |
| sessions / engagedSessions / userEngagementDuration / screenPageViews / eventCount / newUsers | integer | Additive raw values; newUsers summable only across non-overlapping daily rows |
| isOtherRow | boolean | True only for the tail aggregate |
| createdAt / updatedAt | ISO text | — |

**Uniqueness**: `UNIQUE(projectId, propertyId, date, country)`.
**Indexes**: `idx(projectId, date)`, `idx(projectId, country, date)`.

## Ga4DailyTechnology (`ga4_daily_technology`)

Same as geo plus:

| Field | Type | Rules |
|---|---|---|
| device / browser / os | text NOT NULL | Canonical dims with sentinels; `'(other)'` applies per full composite |

**Uniqueness**: `UNIQUE(projectId, propertyId, date, device, browser, os)`.
**Indexes**: `idx(projectId, date)`, `idx(projectId, device, date)`.

## Coverage + truncation meta (extends existing `ga4_sync_coverage` row)

| Field | Type | Rules |
|---|---|---|
| grain | enum | … \| geo \| technology (extended set) |
| state | enum | PENDING \| SUCCESS_WITH_DATA \| SUCCESS_ZERO_ROWS \| FAILED |
| truncation | object \| null | `{isTruncated, retainedDimensionCount, omittedDimensionCount?, otherRowPresent}`; counts only when reliably known |

**State transitions**: `PENDING → SUCCESS_WITH_DATA | SUCCESS_ZERO_ROWS | FAILED`; stale-PENDING (>2h)
reprocessed; idempotent upserts overwrite. Failed units are excluded from all downstream joins.

## Relationships

`ga4_connections 1—* grains` (property mapping); grains `*—1 ga4_sync_coverage` by (project, property,
date, grain). Analytics reads join grains + coverage and accept only `SUCCESS_*`.
