# Implementation Plan: SERP Features Normalization + Dashboard Intelligence UI

**Branch**: `011-serp-features-ui` | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-serp-features-ui/spec.md`

## Summary

Deliver wave-3 package 011 in four coordinated slices: (1) a single **SERP feature presentation
layer** that derives the feature display model from the frozen spec-003 `SerpSnapshot.features`
contract (`SerpFeatureSet`, strict schema — unknown families cannot validate) and renders the ten
observed families (featured result, People Also Ask, related searches, local pack, images, videos,
shopping, news, knowledge graph, sitelinks) on the keyword SERP analysis surface — absent families
stay absent, never fabricated, and PAA is rendered as a feature block that never displaces or
renumbers organic positions; (2) a **mobile card view** for SERP results (position / result /
summary per card, metrics in expansion, zero horizontal overflow, feature blocks in the same card
rhythm); (3) any dashboard-surface gaps in the A1 stored-rollup sections closed strictly on the 001
contracts; (4) the **unified 11-state section model** (A2): the existing `DASHBOARD_SECTION_STATES`
enumeration and `mapStoredSectionState` in `src/shared/intelligence.ts` become the single
deterministic service-to-view mapping for every dashboard section, with the full state matrix
covered by tests and failure states permanently distinct from empty states.

Key grounding facts discovered during planning (they shrink this package considerably):

- Spec 003 already froze the complete normalized `SerpFeatureSet` Zod model in
  `src/server/features/serp/types.ts` with **all ten P14 families**, per-family item shapes, and a
  hard rule that *only observed families appear as keys* (absent = `undefined`, never null-coerced).
  So "normalization" in this package is **not** a new provider mapping — it is one shared
  presentation derivation over that frozen contract, consumed by every SERP-reading surface.
- 001 already delivered the eight dashboard intelligence sections reading stored rollups through
  `DashboardService.getIntelligenceOverview` with per-section `state`, `coverage`, and
  failure-never-zeroed rules (P29/P30 already enforced by `safeSection` → `api_failed`).
- The 11-state model already exists as `DASHBOARD_SECTION_STATES` + `mapStoredSectionState`
  (`src/shared/intelligence.ts` lines 585–669); A2's job is to make it *the* mapping — route every
  section's state derivation through one deterministic function contract and lock the full
  state matrix under test, closing the current gaps (several sections hand-derive `ready`/`stale`/
  `partial`/`empty` outside the shared mapper; `loading`/`permission_failed` have no deterministic
  derivation path on the service side).
- Enrichment survival is already guaranteed by spec 007 (per-row `CompetitiveMetrics.status`
  ∈ `available|partial|unavailable|failed`); this package must render through it, not around it —
  so FR-006 acceptance is a wiring/test exercise, not a new degradation mechanism.

All reads remain stored-data only (G10); no new tables are introduced — confirmed by the
Assumptions section of the spec and verified against `src/db/` schemas.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), React 19, Node 24 / Cloudflare Workers runtime

**Primary Dependencies**: TanStack Start (server functions + `requireProjectContext`), Zod 4
(trust-boundary validation), existing spec-003 `serpSnapshotSchema`/`SerpFeatureSet` contract,
`src/shared/intelligence.ts` section-state contracts, Tailwind/daisyUI for the card view
(established styling: `RankTrackingTableParts.tsx`, `SerpAnalysisCard.tsx`), Vitest 3 + Playwright

**Storage**: no new tables. Reads: stored SERP snapshots (spec 003 storage), stored enrichment
(007), stored rollups/findings (001). Schemas verified: `src/db/*.schema.ts` unchanged.

**Testing**: Vitest colocated (`*.test.ts`); existing suites: `serpBoundaries.test.ts`,
`serpSnapshot.test.ts`, `DashboardService.test.ts`, `intelligence.test.ts` (state mapping),
`RankTrackingTableParts.test.ts`; Playwright `e2e/` for mobile viewport + dashboard state matrix
spot checks.

**Target Platform**: Cloudflare Workers (D1 + PG), Chrome/Edge/Firefox/Safari desktop + mobile
viewports (≤480px minimum supported width for the card view).

**Project Type**: web-application (TanStack Start full-stack)

**Performance Goals**: SERP feature derivation is a pure function over an already-fetched stored
snapshot (no extra reads); dashboard sections keep their existing stored-rollup read shape (the
`Promise.all` fan-out in `getIntelligenceOverview` is preserved); mobile card view renders
≤100 result + feature blocks without layout shift beyond one expansion interaction.

**Constraints**: no render-time paid provider calls (G10/P13); no second SERP normalization or
state model (G4/P14, P30); absent features never rendered (P8/P9); failure ≠ zero/empty
everywhere (P9/P30); PAA placement rule preserved (spec-003 contract: PAA is a feature attribute,
never an organic-position displacement); base SERP must survive enrichment failure (007 status
contract); correlational/observational language only (P46).

**Scale/Scope**: thousands of tracked keywords per project; SERP snapshots of tens of organic
results plus up to 10 feature families; 8 dashboard sections × 11 states = state-matrix surface.

**Open technical decisions** (resolved in [research.md](./research.md)):
- R1: Where the SERP feature presentation derivation lives so every consumer shares exactly one.
- R2: How the existing per-section state derivations unify into the deterministic A2 mapping
  without breaking the current stored-rollup reads (incl. which inputs each section must compute).
- R3: PAA placement rendering rule on the SERP surface (S9) — where placement is honored, and
  what happens when a stored payload lacks placement metadata.
- R4: The mobile card view's relationship to the existing dense table (reuse vs parallel view) and
  the viewport breakpoint.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Post-Phase-1 re-check (2026-10-02): PASS.** Design artifacts ([data-model.md](./data-model.md),
[contracts/](./contracts/), [quickstart.md](./quickstart.md)) were re-verified against each row
below after design: the feature presentation layer derives from the frozen spec-003
`SerpFeatureSet` and is the single consumer-facing mapping (P14/G4 confirmed — no new provider
normalization, `.strict()` schema keeps unknown families out of the view); absent families stay
absent end-to-end (P8/P9 confirmed in the presentation contract — rendering iterates keys, never a
fixed list); the A2 mapping extends the existing `DASHBOARD_SECTION_STATES`/
`mapStoredSectionState` and routes every section's derivation through it with a full state-matrix
test suite (P29/P30 confirmed — `api_failed`/`sync_failed`/`empty`/`no_data` permanently
distinct, `not_connected` before any data check); mobile card view carries the same stored data to
a responsive layout with enrichment-status degradation preserved (P13/007 contract confirmed);
no new tables, no new providers, no render-time paid calls (P6/P13/G10 confirmed). No
violations; no complexity-tracking entries required.

| Gate / Principle | Requirement for this feature | Status |
| --- | --- | --- |
| P1/P2 (layers, no competing architecture) | Feature presentation: one pure derivation module under the SERP feature + shared UI parts; dashboard: extend existing `DashboardService` sections + `src/shared/intelligence.ts` mapping — no parallel stores, normalizers, or state models | PASS by design |
| P3–P5 (DB law) | No new tables; no migration. Reads over existing stored snapshots/rollups only (verified vs `src/db/`) | PASS — assumptions verified |
| P6–P10 (provider law) | Normalization consumed from spec-003 frozen contract; unknown provider families dropped at `.strict()` validation; provider failure renders explicit state, never zero features | PASS — contract inherited |
| P13/G10 (no render-time paid work) | SERP view + dashboard read stored artifacts only; the enrichment view uses the 007 stored status | PASS |
| P14 (one normalized SERP model) | All rendering derives from `SerpFeatureSet`/`serpSnapshotSchema`; no raw provider JSON reaches any SERP-reading surface | PASS — import-ban test extended |
| P29–P30 (dashboard law) | Sections read stored rollups/findings (001); every section resolves exactly one of the 11 states via the single deterministic mapper; failure ≠ zero/empty | PASS — contracts/dashboard-sections.md + state-matrix tests |
| P8/P9 (failure ≠ fact; zero/missing/failed distinct) | Absent feature families never render; `api_failed`/`sync_failed`/`permission_failed` render explicit states with retry — never empty cards or zero counts | PASS |
| P24 (URL identity) | SERP feature ownership references the stored snapshot's own result identity; no re-canonicalization in this package (006 helper untouched) | PASS |
| P38–P40 (security) | Project-context middleware on every server function; no credentials in any surface; public sharing untouched | PASS |
| P41–P42 (trace/ledgers) | Trace taxonomy unchanged; unknown-family drops already logged at ingestion validation (spec 003), presentation layer logs nothing new | PASS |
| P43–P45 (tests/gates) | TDD; unit/state-matrix/UI/E2E per category; `pnpm types:check` + `pnpm oxlint` + parity gates unchanged | PASS — quickstart.md |
| P46–P47 (truthfulness) | Feature wording observational/correlational; enrichment `unavailable`/`failed` rendered explicitly; no causal verbs | PASS |
| P50 (scope discipline) | No new providers/tables/state machines; dashboard desktop layout unchanged; mobile adds a view, doesn't redesign | PASS |

**Violations**: none. No complexity-tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/011-serp-features-ui/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── serp-feature-presentation.md   # single derivation contract over SerpFeatureSet
│   ├── serp-mobile-card-view.md       # responsive layout + expansion contract
│   └── dashboard-sections.md          # A1 sections + unified 11-state mapping (A2)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/serp/
│   ├── types.ts                        # UNCHANGED — frozen 003/007 contract consumed
│   ├── featurePresentation.ts          # NEW: SerpFeatureSet → SerpFeatureBlock[] (pure)
│   └── featurePresentation.test.ts     # NEW: fixtures incl. absent/unknown/placement-less
├── shared/
│   └── intelligence.ts                 # EXTEND: deterministic section-state derivation
│                                         # (stale/permission_failed/loading inputs; single
│                                         #  mapping contract + exported state-matrix table)
├── server/features/dashboard/services/
│   ├── DashboardService.ts             # sections route ALL state derivations through mapper
│   └── DashboardService.test.ts        # + state-matrix coverage via shared table
├── client/features/keywords/components/
│   ├── SerpAnalysisCard.tsx            # + feature blocks render under results (desktop)
│   └── SerpFeatureBlocks.tsx           # NEW: renders SerpFeatureBlock[] (absent-safe)
├── client/features/rank-tracking/
│   └── RankTrackingTableParts.tsx      # feature chips delegate to shared labels/blocks
├── client/features/serp/               # NEW (mobile card view, responsive)
│   ├── SerpResultCards.tsx             # card list: position/result/summary + expansion
│   └── SerpResultCards.test.tsx        # overflow/expansion/content assertions
├── client/features/dashboard/
│   ├── DashboardPage.tsx / DashboardCards.tsx / cardParts.tsx   # render via unified state
│   └── dashboardSectionState.test.ts   # state-matrix UI spot checks
└── e2e/
    ├── serp-features-mobile.spec.ts    # mobile viewport: no overflow, expansion works
    └── dashboard-states.spec.ts        # representative state render checks (not all 88)
```

**Structure Decision**: single-project web application (existing monorepo layout). All new code
follows established feature-folder conventions. No new top-level directories beyond one colocated
`src/client/features/serp/` UI folder for the mobile card view (the SERP server feature already
exists; there is no client `serp/` folder yet — keywords/rank-tracking own the current SERP-read
surfaces). The shared derivation lives server-side next to the frozen contract
(`src/server/features/serp/featurePresentation.ts`) so MCP/UI/任何 server surface share one
implementation; the shared label/block components live client-side.

## Complexity Tracking

> Not applicable — Constitution Check has no violations to justify.
