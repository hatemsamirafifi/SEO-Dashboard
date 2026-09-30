# Data Model: Dashboard Stored Rollups

**Feature**: `001-dashboard-stored-rollups` | **Date**: 2026-09-28

No new persisted tables. Models below are read contracts (service payloads); sources are existing tables.

## DashboardOverview

Per-project aggregated view returned by `DashboardService.getOverview`.

| Field | Type | Rules |
|---|---|---|
| projectId | string | Must match requesting project; mismatch → rejection |
| window | Window | Current day-aligned window |
| previousWindow | Window | Immediately-preceding, equal day length |
| sections | SectionPayload[8] | Exactly the eight output groups, fixed order |

## SectionPayload

| Field | Type | Rules |
|---|---|---|
| key | enum | seo_performance \| search_visibility \| traffic_engagement \| conversions \| opportunities \| technical_health \| backlinks \| recent_changes |
| state | SectionState | 11-state vocabulary; failure states never carry zeroed metrics |
| metrics | object | Section-specific stored values (see contracts/overview-api.md) |
| delta | PeriodDelta \| null | Null = unavailable prior data (never synthetic %) |
| coverage | CoverageNote | Source, freshness, full/partial |

## PeriodDelta

| Field | Type | Rules |
|---|---|---|
| current | number | Stored value, current window |
| previous | number \| null | Null when prior coverage missing/insufficient |
| change | number \| null | Null whenever previous is null |
| changePct | number \| null | Null whenever previous is null or zero |

**Validation**: `previous == null → change == null AND changePct == null` (invariant; tested).

## CoverageNote

| Field | Type | Rules |
|---|---|---|
| source | enum | gsc \| ga4 \| rank \| opportunities \| insights \| audit \| backlinks |
| freshness | string | ISO timestamp of latest underlying data |
| completeness | enum | full \| partial \| none |
| detail | string \| null | e.g. "12/28 days synced", "quota-failed 2026-09-20…" |

## SectionState transitions

`loading → ready | empty | not_connected | no_data | partial | stale | api_failed | permission_failed | sync_running | sync_failed`. States are computed deterministically from coverage + connection state; no transitions persist (computed per read).

## Relationships

`DashboardOverview 1—* SectionPayload`; each `SectionPayload` references its source ledger rows by ID
(sourceRefs) but never duplicates source data.
