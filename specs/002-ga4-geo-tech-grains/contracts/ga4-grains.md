# Contract: GA4 Geo/Technology Grain Reads

**Feature**: `002-ga4-geo-tech-grains` | **Date**: 2026-09-28

Server-function read contract for analytics device/country filtering. Stored grains only.

## Grain read functions

- `getAnalyticsGeo({ projectId, propertyId, from, to })` → rows `{ country, sessions, engagedSessions,
  userEngagementDuration, screenPageViews, eventCount, newUsers, isOtherRow }` + `coverage[]` per date +
  `truncation` flags where applicable.
- `getAnalyticsTechnology({ projectId, propertyId, from, to, dimension: device|browser|os })` → same
  shape keyed by the requested dimension (full composite stored; single-dimension reads aggregate only
  additive metrics).

## Aggregation rules (enforced server-side)

- Additive metrics aggregate with `SUM` over `SUCCESS_*` coverage dates only.
- `newUsers` aggregates with `SUM` only across non-overlapping daily rows **without** dimension rollups;
  dimensioned `newUsers` values are returned per-row and never summed into totals (repository guard).
- Ratios (`engagementRate`, engagement-time-per-session) derive at query from summed components; daily
  rates are never averaged. Distinct-user metrics are never summed.
- `"(other)"` rows are labeled as long-tail aggregates in responses; clients must render them distinctly
  from real dimension values.

## Coverage contract

- Every response carries per-date grain coverage (`SUCCESS_WITH_DATA | SUCCESS_ZERO_ROWS | FAILED`).
- `FAILED` dates are excluded from aggregates and surfaced as failed, never zero.
- `SUCCESS_ZERO_ROWS` dates contribute explicit zeros and are labeled as covered-empty.
- Truncation metadata (`isTruncated`, counts when known, `otherRowPresent`) accompanies any bounded grain,
  letting callers distinguish complete vs truncated coverage.

## Sync write contract (idempotency)

- Grain upserts keyed by deterministic UNIQUE composites; retries/overlapping runs converge without
  duplicates. Partial-chunk failures leave affected coverage `FAILED` (never partial-success rows
  promoted to `SUCCESS_*`).
