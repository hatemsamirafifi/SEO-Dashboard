# Implementation Plan: SERP Top-10 Competitive Enrichment

**Branch**: `007-serp-top10-enrichment` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-serp-top10-enrichment/spec.md`

## Summary

Add opt-in competitive-metric enrichment for the Top-10 organic results of a SERP snapshot: a new
enrichment service in the SERP feature canonicalizes→dedupes→bulk-resolves (bounded per-target calls,
no bulk endpoint exists in the approved set)→merges by normalized identity over the frozen 003
`SerpSnapshot` contract. Target metrics ride the existing DataRouter cache-first pipeline (new 30-day
TTL registry entry, singleFlight coalescing, budget asserts); ETV stays keyword-scoped with the
snapshot and never enters the target cache. Base SERP always renders; failures degrade to explicit
unavailable states with deterministic 40201≠40200 classification. MCP gains an opt-in flag defaulting
to false; the keyword-research panel gains the expanded competitor row.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: Existing DataForSEO clients (`backlinks.ts`, `labs.ts` corroboration), DataRouter + `SeoCacheService` + R2, Zod (contract extension), TanStack Query (panel states), Vitest + existing UI test patterns

**Storage**: No new tables. New cache entries via the existing R2/SeoCacheService pipeline + one centralized TTL registry entry (30-day default, env-overridable per house pattern)

**Testing**: Vitest colocated (new enrichment service test, `serpSnapshot`/`serpBoundaries` extensions, cache/router tests, MCP tool tests, UI row/error-state tests); `pnpm types:check` + `pnpm oxlint`

**Target Platform**: Cloudflare Workers (hosted + self-host), same as existing SERP/resolver code

**Project Type**: Existing monorepo feature extension (SERP feature + keyword-research surface + MCP tool)

**Performance Goals**: Repeat analysis within TTL = zero paid calls; concurrent identical requests coalesce to one fetch per uncached target; base panel latency unchanged when enrichment fails

**Constraints**: Top-10 only (G8/P15); provider-accurate vocabulary only (P16); failure never renders zero (P8/P9/G9); no render-time paid reads outside the explicit analysis path (G10/P13); 40201≠40200 with no blind retry (P10); trace carries no secrets (P41)

**Scale/Scope**: ≤10 deduped targets per enrichment run; per-target cache entries reusable across keywords; target cache keyed (normalized target + metric family + provider)

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- P1 (layering): PASS — SERP service owns enrichment; keyword research + MCP are thin callers; React never parses provider payloads.
- P2 (no competing architecture): PASS — extends resolver/cache/router; no second SERP pipeline (Pipeline B only).
- P6/P7 (provider set, independence): PASS — DataForSEO only, existing endpoints; UI shows capabilities, not provider silos.
- P8/P9/G9 (failure≠zero): PASS — FR-003/FR-004/FR-007 + unavailable/failed states + stale-never-zeroed.
- P10 (error classification): PASS — reuses envelope/billing classification; no new mapping.
- P11–P13/G8 (cache/cost): PASS — Top-10 + dedupe + cache + coalesce + budget asserts; no bulk endpoint exists so bounded per-target is the compliant form; no background refresh.
- P14–P17/G4 (SERP law): PASS — consumes frozen 003 contract additively; merge-by-identity; base survives failure.
- P19 (snapshot vs fetch): PASS — per-metric snapshot/fetch provenance; ETV stays keyword-scoped.
- P41/P42 (trace): PASS — taxonomy extended incrementally; trace observability-only.
- P43–P45 (tests/gates): PASS — full matrix mapped to suites; types:check + oxlint.
- P46/P47 (truthfulness/provenance): PASS — provider-accurate names; provenance per metric family.
- P48 (discovery first): PASS — research.md verifies pipeline, endpoints, cache, trace, UI, and classification in live code.
- P50 (scope discipline): PASS — no new provider/endpoint/table/route; SERP feature families UI stays in 011.
- No gate violations.

## Project Structure

### Documentation (this feature)

```text
specs/007-serp-top10-enrichment/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── enrichment-api.md
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/serp/                        # enrichment service (new) + types.ts (extend additively)
├── server/features/keywords/services/research/serp.ts  # call enrichment post-snapshot (extend)
├── server/features/keywords/services/research/  # keyword-research trace/diagnostics (extend)
├── server/lib/seo-data/config.ts                # TTL registry entry (extend)
├── server/lib/dataforseo/                       # existing clients reused (verify only)
├── server/mcp/tools/get-serp-results.ts         # includeCompetitiveMetrics flag (extend)
├── serverFunctions/keywords.ts                  # getSerpAnalysis passthrough (extend)
└── client/features/keywords/components/SerpAnalysisCard.tsx  # expanded row + states (extend)

tests: colocated src/**/*.test.ts (extend per matrix)
```

**Structure Decision**: Existing monorepo layout; enrichment lives with the SERP contract it consumes,
reusing the router/cache/trace/metering pipeline in place. No new tables, routes, or providers.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
