# Quickstart — spec 011 validation guide

Prerequisites: repo deps installed (`pnpm install`), dev DB seeded per repo README. No new
migrations exist for this package.

## V1 — Feature presentation derivation (unit)

```
pnpm vitest run src/server/features/serp/featurePresentation.test.ts
```

Covers: ten-family fixture renders ten blocks in contract order; absent families produce no
blocks (fabrication guard); placement-less PAA falls back per contract; duplicate items sweep +
log; unknown key dropped safely; pass-through fidelity (items identical to snapshot).

## V2 — Unified 11-state mapping (unit, matrix)

```
pnpm vitest run src/shared/intelligence.test.ts src/server/features/dashboard/services/DashboardService.test.ts
```

Covers: generated state matrix over `mapStoredSectionState` (every input class → exactly one
state; failure inputs can never yield `ready`/`empty`/`no_data`); per-section adapter tests —
each `get*Section` produces inputs that resolve to the documented state for all 11 scenario
classes; `toPeriodDelta` null-previous law unchanged.

## V3 — SERP UI: desktop features + mobile cards (component + E2E)

```
pnpm vitest run src/client        # SerpFeatureBlocks, SerpResultCards suites
pnpm exec playwright test e2e/serp-features-mobile.spec.ts
```

Covers: seeded snapshot with PAA + local pack + news renders exactly those blocks, labeled per
vocabulary table; PAA does not alter organic position numbering; mobile viewport (390×844) has
`document.scrollWidth <= innerWidth` (no overflow); each card shows position/result/summary;
metrics appear only after expanding `serp-card-expand`; long PAA list stays within card bounds;
enrichment `failed`/`unavailable` annotates metric cells while results + features still render.

## V4 — Dashboard states end-to-end (E2E)

```
pnpm exec playwright test e2e/dashboard-states.spec.ts
```

Covers: disconnected-project dashboard renders `not_connected` sections; a project with a failed
sync renders `sync_failed` with retry (never zeros); a zero-item opportunities project renders
`empty`; seeded rollups render `ready` sections whose totals equal the stored fixture values.

## Gates (must stay green)

```
pnpm types:check && pnpm oxlint
pnpm vitest run src/server/features/serp src/shared src/server/features/dashboard src/db/schema-parity.test.ts
```

Boundary guards: extended `serpBoundaries.test.ts` (no provider JSON imports into UI; family
keys declared only in the frozen contract + derivation module).
