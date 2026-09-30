# Quickstart: Canonical SEO URL Identity

**Feature**: `006-canonical-url-identity` | **Date**: 2026-09-30

Validation guide — proves the identity works end-to-end. See [spec](spec.md), [contract](contracts/canonical-identity.md).

## Prerequisites

- Local dev stack running (`docs/LOCAL_DEVELOPMENT.md`); typecheck/lint green (`pnpm types:check`, `pnpm oxlint`).

## Scenarios

### 1. Fixture suite proves fold rules

1. Run the identity fixtures: `pnpm test intelligence` (identity suite).
2. **Expect**: every binding regression pair joins (`/blog` = `/blog/`, www/http folds, Arabic/encoded
   agreement, query variants after policy) and every distinct pair stays distinct (subdomains, ports,
   case, cross-domain). 100% deterministic across two runs.

### 2. Base path semantics unchanged

1. Run: `pnpm test ga4Normalize`.
2. **Expect**: all existing path-normalization cases pass unmodified — GA4 sync storage grain byte-identical.

### 3. Cross-consumer agreement

1. Seed mixed-source rows (GA4 path-only + GSC full URLs + rank URLs for one project host).
2. Run: `pnpm test AnalyticsJoinService`.
3. **Expect**: same-page rows join into one joined row with per-source presence; distinct pages never merge.

### 4. Single-helper guard

1. Run: `pnpm test intelligence-boundaries`.
2. **Expect**: zero bypasses; audit crawl tests (`url-utils.test`) still pass with strict slash-distinct behavior.

### 5. No-history-corruption upgrade

1. Seed a project with stored rows + open opportunities keyed under the old path-only policy.
2. Recompute identity from stored source values twice; run a scan.
3. **Expect**: recomputation deterministic; no duplicate open opportunities for the same logical page;
   superseded-key rows retire through the normal miss/stale lifecycle.

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test ga4Normalize && pnpm test intelligence && pnpm test AnalyticsJoinService && pnpm test intelligence-boundaries
```
