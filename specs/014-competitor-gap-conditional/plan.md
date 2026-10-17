# Implementation Plan: Competitor-Gap Conditional Package

**Branch**: `feat/speckit-wave3-impl` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/014-competitor-gap-conditional/spec.md`

## Summary

This package is the conditional Track C+E competitor-gap work: Part A is a time-boxed input spike that verifies the quality, coverage, cost, and identity stability of DataForSEO competitor inputs (G5, Principle 36); Part B is a detector inside the existing Intelligence Engine; Part C is an autopilot workflow (E1d) over frozen evidence. The package stays Draft until the spike records a `COMPETITOR_GAP_READY` verdict. Implementation extends the existing registry, canonical identity helper (`src/shared/ga4.ts` / `src/shared/intelligence.ts`), cache-first data-router, and autopilot step executor. No new provider, resolver, or queue.

## Technical Context

**Language/Version**: TypeScript, Node.js runtime (package.json engines), Vite build, Vitest tests

**Primary Dependencies**:

- `src/server/features/intelligence/detectors/registry.ts` (existing detector registry, 12 registered detectors)
- `src/server/features/intelligence/services/detectionStage.ts`, `FindingService.ts`, `OpportunityMaterializer.ts` (existing materialization pipeline)
- `src/server/lib/seo-data/providers/dataforseo-provider.ts` + `internal-provider.ts` (DataForSEO and internal-provider access to `competitorSnapshots`)
- `src/server/lib/seo-data/competitor-snapshot-repository.ts` (latest snapshot writes + reads)
- `src/shared/intelligence.ts` (`canonicalUrl()` and `normalizeGa4LandingPage()` chain)
- `src/server/features/autopilot/services/*` (autopilot step executor and workflow services)

**Storage**: Drizzle ORM with D1/SQLite (`src/db/ga4.schema.ts`, `src/db/app.schema.ts`) and PostgreSQL (`src/db/pg/ga4.schema.ts`, `src/db/pg/app.schema.ts`) parity; `competitor_snapshots` table already exists and stores persisted competitor analyses.

**Testing**: Vitest (`pnpm test`), `pnpm types:check`, `pnpm oxlint`; mandatory test types per spec: detector fixtures (intelligence), import-ban boundary tests, materialization idempotency, workflow step executor e2e start→poll→resume, cache-first repeat call tests (007 cache model).

**Target Platform**: Web service (React + server functions) with Cloudflare Workers execution.

**Project Type**: Web service with layered application architecture (client / server function / feature service / repository / provider).

**Performance Goals**: Provider bulk endpoints for Top-10 only; cache-first resolution for repeat data; no N+1 provider patterns (G8); no render-time paid calls (G10).

**Constraints**: G1 (canonical URL identity), G4 (existing normalized SERP contract), G5 (spike only after go), G8 (no SERP N+1), G9 (provider failure never becomes zero/no-result), P8/P9 (failure vs zero vs missing), P14-P17 (SERP normalization and enrichment), P18 (KD raw), P21-P23 (GA4 non-additive), P25-P28 (intelligence law), P29-P36 (dashboard/reports/autopilot), P41-P42 (trace and durable ledgers).

**Scale/Scope**: One input spike → one persisted verdict; conditional detector and autopilot workflow; no new schema unless spike proves need.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

### Post-design re-evaluation (2026-10-09)

_Pre-design gate verdict (from initial check):_ G1, G4, G5, G8, G9, P2, P14–P17, P21–P24, P26–P36, P37–P42, P43–P45, P46–P47, P50 — all pass with the conditions stated in the spec (Part A spike unconditional; Parts B/C gated on `COMPETITOR_GAP_READY`). Design below confirms the initial verdict.

- **Schema**: one additive table (`competitor_gap_verdicts`) with D1/PG parity, append-only, project/org-scoped — P3, P5, P39 satisfied; durable ledger authoritative over trace per P42.
- **No new provider/resolver/engine/queue**: spike measures the approved provider set; detector registers in the existing registry; workflow rides existing autopilot infrastructure — P2, P6, P25, P34, P37 satisfied.
- **Gating mechanics**: structural exclusion precedent (`AUTOPILOT_WORKFLOW_TYPES` test) plus a verdict-ledger gate at detection stage (`skipped` with `G5_NO_READY_VERDICT`, never `failed`) — G5, P28, P35 satisfied; boundary/vocabulary test updates required in the same PR per plan §2.4 discipline (captured in contracts).
- **Failure semantics**: spike dimensions measured as `unavailable` on provider failure (never `0`); detector skip ≠ failure ≠ zero; workflow never fabricates gaps — P8, P9, G9 satisfied.
- **Cost bounds**: spike has declared budget cap; repeat analysis targets 0 paid calls via existing cache model (§007) — P11, P12, G8 satisfied. No render-time paid calls anywhere (G10).
- **Truthfulness**: observed-fact vs recommendation split, provenance classification, no fabricated metric names — P16, P26, P27, P46, P47 satisfied.
- **Testing**: mandatory matrices defined per contract; quality gates named (`pnpm types:check`, `pnpm oxlint`, parity) — P43–P45 satisfied.

**Result**: No new violations introduced by design. G1 extension (canonical identity) remains a tracked dependency (§006), verified in the spike rather than solved here. All previously-listed conditions remain: Part A unconditional; Parts B/C gated on `COMPETITOR_GAP_READY`.

Gates pass with conditions: Part A (spike) may be planned and executed as an isolated spike task. Parts B and C remain gated until `COMPETITOR_GAP_READY` is recorded.

- G1 (canonical URL identity before cross-source page detectors) — REQUIRED: Part B joins GSC/GA4/rank via the single `canonicalUrl()` helper chain. Current helper is path-only and does not yet handle scheme/host/subdomain/percent-encoding; Phase 0 must confirm extension path, not fork. (Spec §3 and §2.1.)
- G4 (existing normalized SERP contract before competitive enrichment) — SATISFIED: contract frozen in `specs/003-serp-contract-discovery/contracts/serp-snapshot.md` and `src/server/features/serp/types.ts` (`serpSnapshotSchema`, `canonicalSerpSnapshot`, `serpSnapshotIdentityKey`). (Plan §2.3)
- G5 (Competitor-gap requires input spike) — GATE: Part A is the only unconditional work. Package stays Draft until `COMPETITOR_GAP_READY` is recorded. (Plan §2.6, Principle 36)
- G8 (No SERP N+1 enrichment) — REQUIRED: Top-10 only, bulk endpoints, dedup by identity, separate snapshot vs metric cache freshness, merge by identity. (Plan §2.3, P17)
- G9 (Provider failure never becomes zero/no-result) — REQUIRED: no-trigger semantics for failed/unavailable inputs; detector must distinguish failed from zero-result. (P8, P9, P28)
- P2 (No competing architecture) — REQUIRED: detector must live in `src/server/features/intelligence/detectors/registry.ts` as a single new detector with no separate engine, resolver, or second canonicalizer. (Spec FR-006, P25)
- P14-P17 (SERP normalization; Top-10 default; accurate metric names; bulk cached merge by identity) — REQUIRED: use existing `SerpSnapshot` contract and accurate DataForSEO metric names (Domain Rank, Page Rank, Referring Domains, Backlinks, etc.); never fabricate DA/PA/DR/TF/CF. (Spec Part B, P16)
- P21-P23 (GA4 non-additive) — REQUIRED: no `SUM(users)`.
- P24 (Cross-source page analysis requires canonical URL identity) — REQUIRED: GSC/GA4/Rank/Audit/SERP joins use the same canonical identity chain.
- P26 (Impact and confidence separate) — REQUIRED: `impactScore`/`confidenceScore` stay distinct.
- P27 (Facts vs recommendations) — REQUIRED: detector produces evidence; recommendations come from materializer/template layer.
- P28 (Provider failure cannot create an opportunity) — REQUIRED: no triggered opportunities from input failures or insufficient coverage.
- P29–P30 (Dashboard stored intelligence and states) — REQUIRED: dashboard surfaces consume stored findings; explicit states (loading/ready/empty/not connected/no data/partial/stale/api failure/permission failure/sync running/sync failed).
- P31–P33 (Reports immutable + scheduled idempotent + raw tokens never persisted) — REQUIRED for any scheduled report generation tied to this feature (Part B/C only if READY; token never persisted).
- P34–P36 (Autopilot orchestrator; bounded; input spike gating) — REQUIRED: Part C MUST consume frozen evidence only; workflow allowlists; no unconstrained autonomous agency; no competitor-gap workflow without spike pass.
- P37 (Cloudflare-native execution) — REQUIRED: scheduled worker / Workflows / Durable Objects only; no new queue engine.
- P38–P40 (Credentials encrypted; project scope mandatory; public sharing separate trust boundary) — REQUIRED: any user-facing output from this package is project-scoped and credential-free.
- P41–P42 (Global trace; durable ledgers authoritative) — REQUIRED: trace only observability; durable ledgers remain authoritative.
- P43–P45 (TDD preferred; mandatory verification categories; quality gates) — REQUIRED: failing tests first where practical; `pnpm types:check`, `pnpm oxlint`, parity tests.
- P46–P47 (No overstating certainty; provenance available) — REQUIRED: all outputs classify observed fact vs third-party estimate vs recommendation; never causal language.
- P50 (Scope discipline) — REQUIRED: part B/C scope is bounded; the package never blocks other packages and never ships without verdict.

Gates pass with conditions: Part A (spike) may be planned and executed as an isolated spike task. Parts B and C remain gated until `COMPETITOR_GAP_READY` is recorded.

## Project Structure

### Documentation (this feature)

```text
specs/014-competitor-gap-conditional/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

### Source Code (repository root)

```text
src/
├── server/features/intelligence/
│   ├── detectors/registry.ts
│   ├── detectors/competitorGap.ts            # [NEW, conditional]
│   ├── detectors/competitorGap.test.ts       # [NEW, conditional]
│   └── services/
│       ├── detectionStage.ts
│       ├── FindingService.ts
│       ├── OpportunityMaterializer.ts
│       └── materializeFinding.ts
├── server/lib/seo-data/
│   ├── providers/dataforseo-provider.ts
│   ├── providers/internal-provider.ts
│   ├── competitor-snapshot-repository.ts
│   └── cache-service.ts
├── shared/
│   ├── ga4.ts
│   ├── intelligence.ts
│   └── autopilot.ts
└── server/features/autopilot/services/
    ├── AutopilotService.ts
    ├── stepExecutor.ts
    ├── autopilotWorkflows.ts
    └── autopilotWorkflowContent.ts
```

**Structure Decision**: The feature follows the established OpenSEO layering (client → server function → feature service → repository → provider). No new architectural layers or directories are introduced. The detector is added to the existing registry; cache-first semantics continue through the data router; autopilot extensions use existing workflow infrastructure.

## Complexity Tracking

> No unjustified violations. The package extends existing systems rather than introducing parallel infrastructure. The only complexity note is G1: canonical URL identity helper must be extended rather than forked to cover scheme/host/subdomain/encoding; that extension is tracked as the binding review correction 2.1.
