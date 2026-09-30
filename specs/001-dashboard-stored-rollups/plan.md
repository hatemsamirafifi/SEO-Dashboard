# Implementation Plan: Dashboard Stored Rollups

**Branch**: `001-dashboard-stored-rollups` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-dashboard-stored-rollups/spec.md`

## Summary

Extend `DashboardService.getOverview` to aggregate the eight intelligence output groups (SEO Performance,
Search Visibility, Traffic & Engagement, Conversions, Opportunities, Technical Health, Backlinks, Recent
Changes) purely from stored/normalized data with immediately-preceding equal-length comparison windows.
No render-time provider calls. The read contracts defined here are frozen for the A1 dashboard-sections
UI package. Approach: extend the existing DashboardService + `searchPerformanceReport` previous-period
helpers; add per-section source/coverage metadata; failure states render unavailable, never zero.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: TanStack Start + Router + Query, React 19, Drizzle ORM, Zod, Cloudflare Workers

**Storage**: Cloudflare D1 (SQLite, canonical) + PostgreSQL mirror via Drizzle; R2 for caches/snapshots

**Testing**: Vitest (colocated `*.test.ts`), Playwright `e2e/`, `schema-parity.test.ts`, `pnpm ci:check`

**Target Platform**: Cloudflare Workers (hosted + advanced self-host), Docker self-host

**Project Type**: Web application (existing monorepo; no new project scaffold)

**Performance Goals**: Dashboard overview resolves from stored reads only; interactive load over standard
windows with no provider round-trips

**Constraints**: Zero paid provider calls on dashboard render (Constitution P13/G10); project-scoped reads
via `requireProjectContext`; failure never coerces to zero (P8/P9)

**Scale/Scope**: Per-project aggregation over existing grains (GSC facts, GA4 daily rows, rank snapshots,
opportunities, insights, audit issues, backlink snapshots)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- P1 (layering): PASS — Server Function → DashboardService → repositories; no logic in components.
- P8/P9 (failure≠zero, zero/missing/failed distinct): PASS — FR-004 + unavailable/null deltas per clarification.
- P13/G10 (no render-time paid reads): PASS — stored reads only; verified via trace (SC-003).
- P29/P30 (stored intelligence surface, explicit section states): PASS — eight groups + 11-state vocabulary.
- P39 (project scope): PASS — FR-005, wrong-project rejection.
- P41/P42 (trace, ledgers authoritative): PASS — no new ledger; trace additions only.
- P50 (scope discipline): PASS — contract layer only; A1 UI and A2 state model are separate packages.
- No new tables, providers, routes, or queues. No gate violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-dashboard-stored-rollups/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/dashboard/services/DashboardService.ts   # extend getOverview
├── server/features/gsc/searchPerformanceReport.ts           # previous-period helpers (reuse)
├── serverFunctions/dashboard.ts                             # extend read fns
├── shared/intelligence.ts                                   # section-state + delta helpers (extend)
└── client/features/dashboard/                               # read-only consumers (A1 builds here later)

tests: colocated src/**/*.test.ts + e2e/dashboard*.spec.ts (extend)
```

**Structure Decision**: Existing monorepo layout; feature extends `dashboard`, `gsc`, and `shared`
modules in place. No new top-level routes (A0 is data/contract layer).

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
