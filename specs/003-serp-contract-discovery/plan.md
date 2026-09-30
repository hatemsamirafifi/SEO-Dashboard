# Implementation Plan: SERP Contract Discovery and Freeze

**Branch**: `003-serp-contract-discovery` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-serp-contract-discovery/spec.md`

## Summary

Inspect and document the actual Keyword Research → SERP resolver → DataForSEO/Serper/Zenserp → normalized
output path, then freeze the single normalized `SerpSnapshot` contract (context + organic results + all
feature families + provider-accurate metric vocabulary + logical identity rule). This package produces
documentation and types only — no enrichment implementation, no new provider calls, no UI changes — and
satisfies hard gate G4, unblocking the 007 enrichment and 011 features-UI packages.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: Existing SERP resolver (`resolverCore`, `providerResolver`, `httpProviders`,
`circuitBreaker`, `retryPolicy`), `SeoCacheService`/R2, singleFlight, cost tracker, Global Trace, Zod

**Storage**: N/A (no new tables; R2 SERP cache documented as-is, TTLs recorded)

**Testing**: Vitest — contract fixture validation (full + sparse snapshots), no-raw-parsing static check,
metric-vocabulary review vs provider docs

**Target Platform**: Cloudflare Workers + Docker self-host (unchanged)

**Project Type**: Web application (existing monorepo); this package is discovery + type freeze

**Performance Goals**: N/A (no runtime changes; contract must support Top-10 bulk enrichment later)

**Constraints**: One normalized model (P14/G4); provider-accurate names only, no DA/PA/DR/TF/CF (P16);
snapshot-time vs fetch-time distinct (P19); absent features stay absent (P8); no second resolver (P2)

**Scale/Scope**: One discovery report + one frozen contract (types + fixture + vocabulary); consumers in
007/011 reference it

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- P2/G4 (no second resolver; contract before enrichment): PASS — this package SHIPS the G4 gate.
- P14 (one normalized SERP model): PASS — FR-002/FR-004.
- P16 (accurate metric names): PASS — FR-005, vocabulary review.
- P19 (snapshot vs fetch time): PASS — FR-006, separate fields.
- P7 (provider-independent product model): PASS — contract exposes SERP capabilities, not provider silos.
- P8 (failure≠fact): PASS — absent features absent (FR-007).
- P50: PASS — docs + types only; enrichment/UI explicitly out of scope.
- No schema, provider, route, or behavior changes. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/003-serp-contract-discovery/
├── plan.md
├── research.md          # discovery report (actual code path, file-referenced)
├── data-model.md        # snapshot model definition
├── quickstart.md
├── contracts/
│   └── serp-snapshot.md # THE frozen contract (identity, shapes, vocabulary)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/serp/
│   ├── types.ts                       # frozen normalized types (extend)
│   └── (resolverCore/providerResolver/httpProviders/circuitBreaker — read-only)
└── server/mcp/tools/                  # get_serp_results handler (read-only reference)

tests: contract fixture validation (new, colocated with serp feature)
```

**Structure Decision**: Read-only inspection of `server/features/serp/*` plus a types-only change to
`types.ts`; the contract document lives in `contracts/serp-snapshot.md` and is the G4 evidence.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
