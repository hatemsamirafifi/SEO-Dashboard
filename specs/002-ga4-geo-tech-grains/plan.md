# Implementation Plan: GA4 Geo and Technology Grains

**Branch**: `002-ga4-geo-tech-grains` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-ga4-geo-tech-grains/spec.md`

## Summary

Add stored `ga4_daily_geo` (per-country) and `ga4_daily_technology` (device/browser/OS) daily grains with
deterministic upsert identity, bounded cardinality via a deterministic "(other)" tail row with truncation
metadata, quota-aware sync reuse, and capability-gated empty states. Analytics device/country filters then
read these grains (DB-first). Approach: mirror the existing GA4 grain tables/sync/coverage patterns
(`ga4.schema.ts` + PG mirror, `Ga4SyncService`, `ga4_sync_coverage` semantics); no sync-architecture changes.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: TanStack Start server functions, Drizzle ORM, Zod, GA4 Data API client
(`ga4Client.ts`), R2 cache, singleFlight, trace provider calls

**Storage**: D1 (SQLite, canonical) + PostgreSQL mirror; new tables in `drizzle/` + `drizzle-pg/` migrations;
writes via `runBatch`/`executeInBatches` only

**Testing**: Vitest colocated, `ga4Migration.test.ts` + `schema-parity.test.ts` extension, quota/partial/
zero-row fixture matrix, `pnpm ci:check`

**Target Platform**: Cloudflare Workers (cron `*/15` with 6h-per-property GA4 floor) + Docker self-host

**Project Type**: Web application (existing monorepo)

**Performance Goals**: Bounded rows/day/property (top-N + "(other)"); sync completes within scheduled window
even at 10x dimension cardinality

**Constraints**: Additive migrations with D1/PG parity (P3/P5); quota-aware halt/resume (P12); zero-row
success distinct from failure (P21); distinct-user metrics never summed (P23); "(other)" = long tail,
never missing/zero (clarified)

**Scale/Scope**: Two new daily grains per property; 16-month retention consistent with existing GA4 tables

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- P3/P4/P5 (parity, repo-only access, additive migrations): PASS — dual-dialect migration + parity tests.
- P12 (bounded paid paths): PASS — bounded cardinality, quota halt, bulk/batch writes.
- P21 (zero-row success): PASS — FR-006, coverage-led-machine reuse.
- P23 (non-additive metrics): PASS — newUsers grain-aware rules; ratios derived at query.
- P8/P9 (failure≠zero): PASS — quota-failed dates never zero-filled; truncation explicit.
- P41/P42 (trace): PASS — `ga4_sync`/`ga4_read` trace extension, ledgers authoritative.
- P50: PASS — grains only; analytics UI filter wiring is the defined consumer, no extra scope.
- No new providers, no router changes (GA4 stays direct service→client per architecture). No violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-ga4-geo-tech-grains/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── db/ga4.schema.ts + pg/ga4.schema.ts        # new grain tables
├── server/features/ga4/services/
│   ├── Ga4SyncService.ts                      # extend grains/chunks
│   ├── ga4SyncUtils.ts                        # bounds, "(other)" rollup
│   ├── Ga4Service.ts                          # grain reads for filters
│   └── scheduledGa4Sync.ts                    # unchanged cadence
├── shared/ga4.ts                              # sentinel + truncation types
└── serverFunctions/ga4.ts                     # geo/tech read fns

drizzle/ + drizzle-pg/                         # new additive migration
tests: colocated + ga4Migration.test.ts + schema-parity.test.ts
```

**Structure Decision**: Follows the exact pattern of the existing four GA4 grains; no new modules,
no sync-architecture changes.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
