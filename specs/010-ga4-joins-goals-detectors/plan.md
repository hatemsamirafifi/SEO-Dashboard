# Implementation Plan: GA4 Joins, Goals, GA4-Backed Detectors, and Opportunities Depth

**Branch**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-ga4-joins-goals-detectors/spec.md`

## Summary

Deliver wave-3 package 010 in four coordinated slices: (1) project-scoped GA4 goals with CRUD and goal-based
analytics filtering that derives conversions from per-grain numerators/denominators (never summed users);
(2) the organic page join correlating GA4, GSC, and rank grains per canonical page — extending the existing
`AnalyticsJoinService` pure join, not creating a second system; (3) two GA4-backed detectors (conversion
drop C2b, engagement drop C2c) registered in the existing detector registry with coverage gating; (4)
composable Opportunities filters (page/keyword/source/type/status/priority) server-side plus evidence
detail on existing surfaces. All data reads are stored-grains only (no render-time provider calls).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), React 19, Node 24 / Cloudflare Workers runtime

**Primary Dependencies**: TanStack Start (server functions + `requireProjectContext` middleware), Drizzle ORM
0.45 (SQLite/D1 + PostgreSQL dual schemas), Zod 4 (trust-boundary validation), Vitest 3 + Playwright

**Storage**: D1/SQLite (`src/db/ga4.schema.ts`) + PostgreSQL (`src/db/pg/ga4.schema.ts`) with parity tests;
new `ga4_project_goals` table (additive migration, both dialects); existing grains: `ga4_daily_events`
(eventName, eventCount, isKeyEvent), `ga4_daily_landing_pages`, `ga4_daily_acquisition`, `ga4_daily_geo`,
`ga4_daily_technology`; `opportunities` (keyword/page/type/status/priority columns + indexes already present)

**Testing**: Vitest colocated (`*.test.ts`), `schema-parity.test.ts`, `ga4Migration.test.ts`,
`intelligence-boundaries.test.ts`, detector fixture tests, Playwright `e2e/`

**Target Platform**: Cloudflare Workers (D1 + PG deployments), Chrome/Edge/Firefox/Safari for UI

**Project Type**: web-application (TanStack Start full-stack)

**Performance Goals**: organic join bounded database-first (batched reads, no unbounded in-memory
cross-source loops); Opportunities filter composition within normal interactive time (server-indexed
queries — indexes on project+page, project+keyword, project+type+status, project+priority+impact already
exist)

**Constraints**: no render-time paid provider calls (G10); no second join/canonicalizer/engine (G1, G3);
failure≠zero everywhere (G9); D1/PG parity mandatory; summing non-additive users prohibited (P23)

**Scale/Scope**: thousands of canonical pages per project; goals bounded per project (enforced cap);
detector windows per existing threshold conventions (minWindowDays 28/7)

**Open technical decisions** (resolved in [research.md](./research.md)):
- Goal definition model (which GA4 event mapping a goal binds to) — research task R1
- Engagement metric for the C2c detector — research task R2
- Conversion/engagement threshold defaults and evidence shape — research task R3
- Server vs client filter split for the Opportunities dimensions — research task R4

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Post-Phase-1 re-check (2026-10-01): PASS.** Design artifacts ([data-model.md](./data-model.md),
[contracts/](./contracts/)) were re-verified against each row below after the design was written:
goals bind to stored event grains with additive event-count sums only (P23 confirmed — no user sums
anywhere in the contracts); the join contract extends the existing pure function with null-for-absent
semantics and reuses the 006 identity fixture suite (P24/G1); both detectors register in the existing
registry with skip-reason coverage gating (P25/P28/G9); filters compose over existing indexes with
explicit empty/failed states (P29/P30/P39); the goals table is additive with parity tests named
(P3–P5). No violations; no complexity-tracking entries required.

| Gate / Principle | Requirement for this feature | Status |
| --- | --- | --- |
| P1 (layers) | Goals: server fn → Ga4GoalService → repository; join: service-layer pure extension; detectors: existing engine pipeline | PASS by design |
| P2 (no competing architecture) | Extend `AnalyticsJoinService.joinUrlEvidence` + `ga4_daily_events`; no parallel join, canonicalizer, or engine | PASS — import-ban tests extended |
| P3–P5 (DB law) | `ga4_project_goals` additive on D1+PG, project-scoped FK, parity + migration tests in same change | PASS — data-model.md |
| P23 (non-additive users) | Goal conversions from per-grain event/numerator counts; distinct users never summed across grains/periods | PASS — contract |
| P24 / G1 (URL identity) | Join keys exclusively via `canonicalUrl()` (006 helper); boundary guard already covers join service | PASS — frozen upstream contract |
| P25 / G3 (one engine) | Both detectors in existing `DETECTORS` registry, existing materializer/templates | PASS |
| P26 (impact/confidence separate) | Existing separate columns preserved; no combined score | PASS |
| P27 (facts vs recommendations) | Detectors emit `explanationFact` only; recommendations from templates | PASS |
| P28 / G9 (failure ≠ trigger) | `InsufficientCoverageError` skip path + no-trigger on absent GA4; failure renders unavailable | PASS |
| P29–P30 / G10 (dashboard law) | All new reads over stored grains; honest states via existing `AnalyticsCoverage`/page-view patterns | PASS |
| P38–P39 (security) | Project context middleware on every server fn; MCP tools thin over same services; no credentials in trace | PASS |
| P41–P42 (trace/ledgers) | `ga4_goal_change` trace entries; opportunity event ledger stays authoritative/idempotent (`eventKey` unique) | PASS |
| P43–P45 (tests) | TDD; unit/repository/service/UI/E2E per category; `pnpm types:check` + `pnpm oxlint` + parity gates | PASS — quickstart.md |
| P46–P47 (truthfulness) | Join wording correlational; conversions labeled per classification; no causal verbs | PASS |
| P50 (scope discipline) | No new providers/tables beyond goals; MCP wrappers thin; no UI redesign | PASS |

**Violations**: none. No complexity-tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/010-ga4-joins-goals-detectors/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── goals-api.md
│   ├── organic-join.md
│   ├── detector-findings.md
│   └── opportunities-filters.md
└── tasks.md             # Phase 2 output (/speckit.tasks - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── db/
│   ├── ga4.schema.ts                    # + ga4ProjectGoals table
│   ├── pg/ga4.schema.ts                 # + ga4ProjectGoals mirror
│   ├── schema.ts / pg/schema.ts          # exports
│   ├── schema-parity.test.ts             # extended
│   └── ga4Migration.test.ts             # extended
├── server/
│   ├── features/ga4/
│   │   ├── repositories/Ga4GoalRepository.ts        # new (persistence only)
│   │   └── services/
│   │       ├── Ga4GoalService.ts                     # new (CRUD + validation)
│   │       └── AnalyticsService.ts                   # goal-scoped filtering
│   ├── features/intelligence/
│   │   ├── detectors/
│   │   │   ├── conversionDrop.ts                     # new (C2b)
│   │   │   ├── engagementDrop.ts                     # new (C2c)
│   │   │   ├── inputs.ts                             # dispatcher + cases
│   │   │   └── registry.ts                           # explicit entries
│   │   ├── services/AnalyticsJoinService.ts         # extended pure join
│   │   └── services/opportunityTemplates.ts         # per-detectorKey templates
│   └── mcp/tools/analytics-tools.ts                 # thin goal-scoped wrappers
├── serverFunctions/
│   ├── ga4.ts                                        # goal CRUD fns (+ auth tests)
│   └── opportunities.ts                              # extended list filters
├── client/features/opportunities/
│   ├── OpportunitiesPage.tsx                        # filter toolbar
│   └── opportunitiesCopy.ts                         # filter state helpers
├── shared/intelligence-thresholds.ts                # conversion_drop/engagement_drop entries
└── types/schemas/
    ├── ga4.ts                                        # goal schemas + analytics filter shape
    └── opportunities.ts                             # extended list schema
```

**Structure Decision**: single-project web application (existing monorepo layout); all new modules follow
the established feature-folder convention (repositories/services/detectors colocated under their feature).
No new top-level directories.

## Complexity Tracking

> Not applicable — Constitution Check has no violations to justify.