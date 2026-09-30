# Quickstart: GA4 Geo and Technology Grains

**Feature**: `002-ga4-geo-tech-grains` | **Date**: 2026-09-28

Validation guide. See [spec](spec.md), [contract](contracts/ga4-grains.md).

## Prerequisites

- Local dev stack; GA4 test property connected; both D1 (local) and PG (local) available for parity
  (`docs/LOCAL_POSTGRES.md`); `pnpm types:check`, `pnpm oxlint` green.

## Scenarios

### 1. Geo/tech grains sync and read back

1. Run a GA4 sync covering a known window for the test property.
2. Query `getAnalyticsGeo` + `getAnalyticsTechnology` for the window.
3. **Expect**: per-country and per-device/browser/OS rows with the six metrics; coverage `SUCCESS_WITH_DATA`;
   totals reconcile with the summary grain for the same dates.

### 2. "(other)" tail + truncation metadata

1. Sync a property (or fixture) exceeding the per-grain bound.
2. **Expect**: deterministic `"(other)"` row present, aggregates exact vs unbounded fixture totals,
   `isTruncated: true` with `otherRowPresent: true`; no silently dropped values.

### 3. Quota failure honesty + resume

1. Simulate quota exhaustion mid-sync; check coverage per date/grain.
2. **Expect**: synced dates usable, failed dates `FAILED`/quota-flagged with no zero-filled traffic rows.
3. Retry after reset.
4. **Expect**: backfill completes with zero duplicate rows (UNIQUE composites hold).

### 4. Parity + math guards

1. Run migrations on both backends; run `pnpm test ga4Migration schema-parity`.
2. **Expect**: green; no `SUM(users)` violations; dimensioned `newUsers` refused at rollup.

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test Ga4SyncService ga4SyncUtils Ga4Service
pnpm test ga4Migration schema-parity
```
