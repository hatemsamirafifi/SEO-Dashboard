# Contract: Dashboard Overview Read API

**Feature**: `001-dashboard-stored-rollups` | **Date**: 2026-09-28

Server-function read contract consumed by the dashboard (and later the A1 sections UI). Stored-data only.

## `getDashboardOverview`

- **Input**: `{ projectId: string }` — strict validation; wrong-project → rejection.
  Organization/user context is server-supplied (no client input). Window is fixed to the trailing
  28 days ending today; custom ranges are a later package.
- **Previous window derivation (server-side, shared logic)**: `previousPeriod(from, to)` from
  `searchPerformanceReport.ts` — the immediately-preceding equal-length day-aligned window, reused
  for GSC, GA4 (`resolveAnalyticsWindows("last_28_days")` derives the identical windows), and rank reads.
- **Output**: legacy `{ rank, audit, backlinks }` (unchanged, for existing cards and report snapshots)
  merged additively with `{ window, previousWindow, sections }` — eight `SectionPayload`s in fixed order,
  each with `state`, `metrics`, `delta | null`, `coverage`.
- **Invariants**:
  - Zero paid provider calls per invocation (assertable via trace: no paid activity).
  - `delta.previous == null ⟹ delta.change == null AND delta.changePct == null`.
  - Failed/missing source → section `state ∈ {not_connected, no_data, api_failed, permission_failed,
    sync_running, sync_failed, partial, stale}` with metrics absent — never zero-filled.
  - Partial coverage sets `state = partial` with `coverage.detail` (e.g. "12/28 days"), never silent full.

## Per-section metric shapes (stored values only)

- `seo_performance`: `{ clicks, impressions, ctr, avgPosition }` + deltas.
- `search_visibility`: `{ top3, top10, top100, improved, declined, unavailableCount }`.
- `traffic_engagement`: `{ sessions, organicSessions, engagedSessions, engagementRate, coverage }`.
- `conversions`: `{ keyEvents: [{name, count}], transactions? }` or `not_configured` state.
- `opportunities`: `{ critical, high, medium, deepLink }`.
- `technical_health`: `{ health, importantPageIssues, lastAuditAt }` or `stale/no_audit` state.
- `backlinks`: `{ total, referringDomains, newCount, lostCount }`.
- `recent_changes`: `{ items: [{ fact, recommendation?, sourceBadge, detectedAt }] }` — fact and
  recommendation in distinct blocks.

## Stability promise

Field names, section keys, and state vocabulary are frozen for the A1 UI package; additive metric fields
only, no renames without a versioned migration of this contract.
