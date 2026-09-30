# Implementation Plan: Lost-Backlink Opportunity

**Branch**: `008-lost-backlink-opportunity` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-lost-backlink-opportunity/spec.md`

## Summary

Split lost-backlink detection into its own prioritized opportunity: a new `lost_backlinks` detector (registered, versioned, threshold-gated) compares the two newest stored backlink snapshots and, only when `lostReferringDomains ≥ 3`, resolves the lost-domain names through the cached referring-domains service path and freezes them into evidence. Provider failure or missing coverage anywhere in the chain is a recorded no-trigger — never a loss. Materialization reuses the existing pipeline (template + ledger + lifecycle) with a new template entry sharing the `"backlinks"` opportunity type; the existing `backlink_change` detector is untouched.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: Existing Intelligence Engine (detector registry, materializer, templates, ledger), `BacklinkSnapshotRepository`, DataRouter + cached referring-domains service path, Vitest

**Storage**: No schema changes. Reads `backlink_snapshots` (aggregates) + cached provider path for names; opportunities/events persist through the existing ledger tables.

**Testing**: Vitest colocated (new `lostBacklinks.test.ts` floor matrix + negatives + idempotency; `detectorInputs.test.ts` fetcher negatives; `opportunityTemplates.test.ts` scoring; registry/boundaries list updates); `pnpm types:check` + `pnpm oxlint`

**Target Platform**: Cloudflare Workers (hosted + self-host), same as existing detectors (scheduled-scan context)

**Project Type**: Existing monorepo detector + opportunity extension (no new engine, tables, routes, or UI)

**Performance Goals**: Common case costs zero paid calls (aggregate floor check on stored rows); name resolution fires at most once per scan per project and only on genuine triggers, through cache-first + budget guards

**Constraints**: Provider failure/partial/insufficient coverage never emits (G9/P28); single intelligence model and separate impact/confidence preserved (G3/P25–P27); no second scoring system; existing `backlink_change` behavior byte-identical

**Scale/Scope**: One detector file + registry/template/threshold entries + evidence bounded to top-N named domains + aggregate counts

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- P1 (layering): PASS — detector + input fetcher follow the existing detection-stage shape; services own materialization.
- P2/P25/G3 (one engine): PASS — registers in the existing registry; reuses materializer, templates, ledger, scoring; no parallel system.
- P8/P9/P28/G9 (failure≠loss): PASS — floor on stored data; provider failure at any stage ⇒ no-trigger with recorded reason; capped confidence per coverage rules.
- P11–P13 (cache/cost): PASS — zero-paid common case; paid leg only on trigger, cached, budgeted, bounded single page.
- P26/P27 (scores, facts vs recommendations): PASS — separate impact/confidence; detector emits facts only; materializer adds the reclaim recommendation.
- P39 (project scope): PASS — snapshots and opportunities are project-scoped; no cross-project reads.
- P41/P42 (trace/ledgers): PASS — existing run/ledger records; no new ledger.
- P43–P45 (tests/gates): PASS — full matrix mapped to suites; types:check + oxlint.
- P48 (discovery first): PASS — research.md verifies snapshot grain, provider paths, registry, templates, thresholds, and idempotency in live code.
- P50 (scope discipline): PASS — no new tables, providers, routes, engines, or UI; page-level loss stays out (006-gated later work).
- No gate violations.

## Project Structure

### Documentation (this feature)

```text
specs/008-lost-backlink-opportunity/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── lost-backlink-opportunity.md
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/intelligence/detectors/lostBacklinks.ts      # new detector + input fetcher
├── server/features/intelligence/detectors/lostBacklinks.test.ts # new (floor matrix, negatives, idempotency)
├── server/features/intelligence/detectors/registry.ts           # register (extend)
├── server/features/intelligence/detectors/detectorInputs.test.ts# fetcher negatives (extend)
├── server/features/intelligence/detectors/detectorTestSeeds.ts  # backlink seed pattern (extend)
├── server/features/intelligence/services/opportunityTemplates.ts# lost_backlinks entry (extend)
├── server/features/intelligence/services/opportunityTemplates.test.ts  # scoring (extend)
├── server/features/intelligence/services/materializeFinding.test.ts    # lifecycle (extend)
├── server/features/intelligence/intelligence-boundaries.test.ts # DETECTOR_FILES list (extend)
└── shared/intelligence-thresholds.ts                        # lost_backlinks thresholds (extend)

tests: colocated src/**/*.test.ts (extend)
```

**Structure Decision**: Existing monorepo layout; feature adds one detector module plus registry/template/threshold entries in place. Snapshot storage, materializer, ledger, and lifecycle are verify-only.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
