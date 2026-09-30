# Implementation Plan: Striking Distance Detector

**Branch**: `004-striking-distance-detector` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

## Summary

Add a deterministic striking-distance detector (positions 11–20 inclusive via shared band constants,
impressions floor, coverage-gated, frozen observational evidence) to the explicit versioned detector
registry. The existing 5–20 GSC helper is untouched except for a superset comment. Re-detection updates
in place; terminal rows never reopen; the existing opportunity model, scoring, and materializer are reused
unchanged (G3).

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: Intelligence Engine (`detectors/registry.ts`, `types.ts`, `FindingService`,
`OpportunityMaterializer`, `SourceTokens`), `shared/intelligence.ts` (keys, renormalization, matrix),
GSC page/query grains + rank snapshots as inputs

**Storage**: No new tables (findings transient → R2 artifact; opportunities via existing tables)

**Testing**: Vitest detector fixtures (positives, band edges 10/11 + 20/21, below-floor, partial coverage,
failed rank, multi-URL queries), identity/lifecycle tests, `pnpm ci:check`

**Target Platform**: Cloudflare Workers (existing intelligence cron/scheduler) + Docker self-host

**Project Type**: Web application (existing monorepo)

**Performance Goals**: Pure synchronous detection over pre-fetched inputs; scan overhead linear in entity count

**Constraints**: One detector per condition (P25/G3); thresholds injected + echoed (no magic numbers);
coverage FAILED blocks emission (P28); observational language only, correlation≠causation (P46);
band constants shared, helper documented as superset (clarified)

**Scale/Scope**: One detector file + fixtures + registry entry + helper comment; no service redesign

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- P25/G3 (one engine, frozen opportunity model): PASS — registry plug-in, materializer untouched.
- P26 (impact/confidence separate, renormalized): PASS — existing scoring reused.
- P27 (fact vs recommendation): PASS — detector emits `explanationFact` only.
- P28 (failure can't create opportunity): PASS — FR-002 skip rules + ledger reasons.
- P24 (canonical identity): PASS — `canonicalKeyword`/entity keys via shared helpers.
- P46 (no causal claims): PASS — observational evidence type only.
- P50: PASS — single detector; no new tables/routes/providers.
- No violations.

## Project Structure

### Documentation (this feature)

```text
specs/004-striking-distance-detector/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── detector-finding.md  # finding/evidence shape for this detector
└── tasks.md                 # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/intelligence/detectors/
│   ├── strikingDistance.ts       # NEW detector + band constants
│   ├── strikingDistance.test.ts  # NEW fixtures
│   └── registry.ts               # register (1-line + versions)
├── server/features/gsc/searchPerformanceReport.ts  # superset comment only
└── shared/intelligence.ts        # band-constant home if shared (research decides)

tests: colocated fixtures + registry.test.ts extension
```

**Structure Decision**: Mirrors existing detectors (`lowCtrQuery.ts` pattern); registry stays an explicit list.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
