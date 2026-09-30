# Quickstart: Lost-Backlink Opportunity

**Feature**: `008-lost-backlink-opportunity` | **Date**: 2026-09-30

Validation guide — proves the detector works end-to-end. See [spec](spec.md), [contract](contracts/lost-backlink-opportunity.md).

## Prerequisites

- Local dev stack running (`docs/LOCAL_DEVELOPMENT.md`); seeded backlink snapshots via the detector-test seed pattern; typecheck/lint green (`pnpm types:check`, `pnpm oxlint`).

## Scenarios

### 1. Floor-gated emission with named evidence

1. Seed two consecutive snapshots where 5 referring domains present in the earlier are absent in the later (floor 3).
2. Run the detector + materializer over the pair.
3. **Expect**: exactly one `lost_backlinks` opportunity with frozen evidence naming the 5 domains, snapshot timestamps, and split impact/confidence; the aggregate `backlink_change` finding still emits unchanged.

### 2. Below-floor and unknown inputs stay silent

1. Seed pairs with 0, 1, 2 lost referring domains, and one with null totals.
2. **Expect**: zero opportunities from all four; each skip recorded with its reason. Run: `pnpm test lostBacklinks` — floor matrix green.

### 3. Failure never becomes loss

1. Simulate failed snapshot sync, single-snapshot history, stale pair, and name-resolution failure.
2. **Expect**: zero loss findings in every case; run ledger shows skips with reasons, never a loss event.

### 4. Idempotent re-scan and lifecycle

1. Re-run the scan over identical inputs twice; move the opportunity through open → in-progress → dismissed with reason.
2. **Expect**: no duplicate opportunities or ledger events; every transition recorded once, like existing types.

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test lostBacklinks && pnpm test detectorInputs && pnpm test opportunityTemplates && pnpm test materializeFinding
pnpm test intelligence-boundaries && pnpm test registry
```
