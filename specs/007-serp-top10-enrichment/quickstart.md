# Quickstart: SERP Top-10 Competitive Enrichment

**Feature**: `007-serp-top10-enrichment` | **Date**: 2026-09-30

Validation guide — proves enrichment works end-to-end. See [spec](spec.md), [contract](contracts/enrichment-api.md).

## Prerequisites

- Local dev stack running (`docs/LOCAL_DEVELOPMENT.md`); DataForSEO credentials configured for live checks (or recorded fixtures for offline runs); typecheck/lint green (`pnpm types:check`, `pnpm oxlint`).

## Scenarios

### 1. Top-10 enriches, position 11+ does not

1. Run SERP Analysis with competitive metrics on a fixture keyword (10+ results).
2. **Expect**: exactly the Top-10 rows show core metrics (or explicit unavailable); rows 11+ show no metrics and triggered zero enrichment calls. Run the enrichment service tests — selection/merge cells pass.

### 2. Repeat and concurrent runs cost nothing extra

1. Repeat the same analysis within the target window; fire two concurrent identical requests.
2. **Expect**: zero new paid calls on repeat (trace shows cache hits); the concurrent pair coalesces to one paid fetch per uncached target. Freshness boundaries hold (29d hit / 30d fresh / 31d stale).

### 3. Failures degrade, never break

1. Inject account-paused, credits-unavailable, partial-bulk, and total-failure modes.
2. **Expect**: each renders its distinct state with the full base panel visible; zero false zeros recorded; permanent failures not retried. Run: `pnpm test` on the error-classification and error-card suites.

### 4. MCP parity and vocabulary

1. Call `get_serp_results` with and without `includeCompetitiveMetrics`.
2. **Expect**: untoggled response byte-identical to today; toggled response carries merged metrics for Top-10 only. Boundary test confirms zero proprietary metric names.

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test serpSnapshot && pnpm test serpBoundaries
pnpm test keywordResearchErrors
# enrichment service + cache/router suites per tasks.md
```
