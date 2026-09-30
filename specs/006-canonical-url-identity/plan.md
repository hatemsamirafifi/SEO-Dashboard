# Implementation Plan: Canonical SEO URL Identity

**Branch**: `006-canonical-url-identity` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-canonical-url-identity/spec.md`

## Summary

Extend the existing path-only normalizer chain into the single canonical SEO page identity: `canonicalUrl`
(`src/shared/intelligence.ts:89`) gains the clarified analytical folds (www→bare, http→https,
non-root trailing-slash fold, duplicate-slash collapse, safe percent-encoding normalization, lowercase
host, case-preserved path) plus project-host-context resolution for path-only GA4 rows. `normalizeGa4LandingPage`
keeps strict path semantics for GA4 stored grain; audit's `canonicalUrlKey` keeps strict crawl semantics
(documented P24 exception). All analytical consumers route through the one helper, enforced by an
extended boundary guard; stored rows are never rewritten — superseded opportunity keys retire via the
existing miss/stale lifecycle. Ships hard gate G1.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: Zod (identity-adjacent validation where reused), Drizzle ORM (reads only — project domain lookup), Vitest, WHATWG `URL` API (Workers + Node compatible)

**Storage**: No schema changes. Reads `projects.domain` (`src/db/app.schema.ts:53`) for host context; GA4 stored rows (`landingPage` + `rawLandingPage`, `ga4SyncNormalize.ts:297-310`) untouched.

**Testing**: Vitest colocated (`intelligence.test.ts`, `ga4Normalize.test.ts`, `AnalyticsJoinService.test.ts`); boundary-guard extension in `intelligence-boundaries.test.ts`; `pnpm types:check` + `pnpm oxlint`

**Target Platform**: Cloudflare Workers (hosted + self-host), same as existing shared helpers

**Project Type**: Existing monorepo feature extension (no new project, no new routes, no new tables)

**Performance Goals**: Identity is pure synchronous computation; join/scan latency unchanged (no provider calls, no new persistence)

**Constraints**: Stored GA4 fact keys must not shift (sync normalization byte-identical); no invented hosts (null domain → path-scoped); analytical identity is never presented as Google canonical equivalence (P46)

**Scale/Scope**: Fixture suite covers the clarified regression pairs + alias/subdomain/port/encoding/Arabic/cross-domain families; consumer audit covers all current `canonicalUrl`/`normalizeGa4LandingPage` call sites

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- P1 (layering): PASS — pure shared helpers; no service/component logic moves.
- P2 (no competing architecture): PASS — extends the single chain; audit strict helper is a documented distinct concern, not a second identity (research Decision 2).
- P24 (URL identity): PASS — one analytical identity + fixtures + guard; audit exception documented with rationale.
- P39 (project scope): PASS — host context comes from the project's own config; no cross-project identity.
- P43–P45 (tests, gates): PASS — fixture suites + guard + agreement test; types:check + oxlint.
- P46 (truthfulness): PASS — analytical join identity, explicitly not a Google-canonical claim (clarified rule 7).
- P48 (discovery first): PASS — research.md verifies every consumer, storage grain, and guard mechanism in live code.
- P50 (scope discipline): PASS — no new detector, join, table, route, or UI; audit crawl behavior untouched.
- G1: SHIPPED BY THIS PACKAGE — recorded as passed when the fixture suite and guard are green.
- No new tables, providers, routes, queues, or detectors. No gate violations.

## Project Structure

### Documentation (this feature)

```text
specs/006-canonical-url-identity/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── canonical-identity.md
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── shared/ga4.ts                                  # strict path semantics UNCHANGED
├── shared/intelligence.ts                         # canonicalUrl becomes full identity (extend)
├── shared/ga4Normalize.test.ts                    # proves base semantics unchanged (extend)
├── shared/intelligence.test.ts                    # identity fixture suite (extend)
├── server/features/ga4/services/ga4SyncNormalize.ts        # storage grain unchanged (verify only)
├── server/features/intelligence/services/AnalyticsJoinService.ts      # host-context join (extend)
├── server/features/intelligence/services/AnalyticsJoinService.test.ts # agreement test (extend)
├── server/features/intelligence/detectors/        # existing canonicalUrl call sites (verify)
├── server/features/intelligence/intelligence-boundaries.test.ts       # identity guard (extend)
└── server/lib/audit/url-utils.ts                  # strict crawl identity UNCHANGED (documented)

tests: colocated src/**/*.test.ts (extend)
```

**Structure Decision**: Existing monorepo layout; feature extends `shared` identity helpers plus the
analytical consumers in place. GA4 sync storage, audit crawl, and all other surfaces are verify-only.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
