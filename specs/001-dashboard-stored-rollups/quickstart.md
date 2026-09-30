# Quickstart: Dashboard Stored Rollups

**Feature**: `001-dashboard-stored-rollups` | **Date**: 2026-09-28

Validation guide — proves the feature works end-to-end. See [spec](spec.md), [contract](contracts/overview-api.md).

## Prerequisites

- Local dev stack running (`docs/LOCAL_DEVELOPMENT.md`); test project with GSC connected and one
  completed sync; typecheck/lint green (`pnpm types:check`, `pnpm oxlint`).

## Scenarios

### 1. Overview renders eight groups with deltas

1. Seed/sync GSC + GA4 + rank + opportunities + insights + audit + backlinks for the test project.
2. Call `getDashboardOverview({ projectId, window })`.
3. **Expect**: eight sections in fixed order, each with `state: ready`, metrics, non-null `delta`, and
   `coverage { source, freshness, completeness: full }`.
4. Assert via trace diagnostics: **zero paid provider calls** for the invocation.

### 2. Failed source renders unavailable, never zero

1. Force a GSC sync failure (or disconnect GA4) for the test project.
2. Reload the overview.
3. **Expect**: affected sections show failure/not-connected states; no section reports `0` for the failed
   source. Run: `pnpm test DashboardService` — failure-semantics cases pass.

### 3. New project shows guidance, no errors

1. Create a fresh project with no connected sources; load the overview.
2. **Expect**: all sections in guidance states (`not_connected`/`no_data`), no error banners, deltas null.

### 4. Contract stability for A1

1. Diff the response shape against [contracts/overview-api.md](contracts/overview-api.md).
2. **Expect**: section keys, state names, and delta invariants unchanged (additive metric fields only).

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test DashboardService
pnpm test:e2e dashboard   # if dashboard e2e spec exists; otherwise record as follow-up
```
