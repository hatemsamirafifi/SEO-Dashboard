# Research: Competitor-Gap Conditional (spec 014)

Phase 0 research to resolve unknowns before design. G5 gate: only Part A (spike) is unconditional.

## R1 — Where does competitor data already live? (no new provider)

**Decision**: Reuse the existing SERP-competitor pipeline: `competitor_snapshots` table + `competitor-snapshot-repository.ts` + the seo-data router (`dataType: "competitors"`, internal → dataforseo precedence).

**Rationale**: DataForSEO Labs `serp_competitors` is already integrated with write-through persistence (`persistCompetitorSnapshot`) and an internal provider reading latest snapshots with project/market scoping. `find_serp_competitors` MCP tool already exposes it with budget guards. Constitution P6 (approved provider set) and P12 (bounded paid paths) are satisfied by construction; no new provider or table needed for the spike.

**Alternatives considered**: New `competitor_domains` entity table — rejected (P2/P50; would parallel existing configuration surfaces). Direct DataForSEO calls from the detector — rejected (P1 layering, P11 cache-first; detectors receive pre-fetched inputs per `DetectorContext`).

## R2 — Where does the verdict live durably? (Principle 42: durable ledgers, not trace)

**Decision**: A new append-only `competitor_gap_verdicts` table (D1 + PG parity), one row per spike run, storing verdict enum, frozen evidence JSON, threshold set evaluated, spike input manifest, recorded-at. This is the authoritative source consulted before any Part B/C code path is enabled.

**Rationale**: The verdict gates runtime behavior (detector registration / workflow availability), must be immutable per FR-003, and must survive deploys — trace rows are observability only (P42). A durable ledger matches how sync ledgers and autopilot steps are treated elsewhere. Table is additive, project/org-scoped, parity-tested.

**Alternatives considered**: Config file / env var — rejected (not durable per-org, not auditable). Storing in Global Trace — rejected (P42: trace never source of truth). A boolean column on projects — rejected (loses evidence and supersession history).

## R3 — What does the spike actually measure? (FR-001 dimensions → concrete measurements)

**Decision**: The spike harness measures five dimensions against a maintainer-selected sample of representative competitor domains (default: up to 5 domains drawn from existing `find_serp_competitors` output for the project's keyword set):

1. **Data quality**: keyword coverage of competitor domains — `% of sampled keywords where domain has any ranked-keyword rows`, missing-field rates on required fields (position, URL, volume proxy).
2. **Coverage**: presence of stored first-party data (GSC/rank/audit) needed to express "user site absent/weaker" for the same query set — measured as coverage ratio against the window.
3. **Cost**: credits consumed per full competitor-set analysis (sampled calls), measured via existing budget/cost trace metadata; extrapolated per-project monthly cost.
4. **Identity stability**: canonical identity of competitor domains/URLs via the §006 chain — measure collisions and non-determinism across raw variants (scheme, host, case, trailing slash, encoding).
5. **Cache reuse**: run the same analysis twice; measure paid-call count on the second run — must be 0 (target: 100% cache hit on repeat).

**Rationale**: Directly instantiates spec FR-001(a)–(e) with measurable outputs that a reviewer can verify from frozen evidence (SC-002).

**Alternatives considered**: Measuring perceived quality via manual review — rejected (not reproducible). Measuring against live production traffic — rejected (cost, non-determinism; the spike uses a declared sample).

## R4 — Pass thresholds (pre-registered, not hard-coded)

**Decision**: Thresholds are declared in the spike's input manifest before execution, following these structural rules:

- Hard BLOCK conditions (any one BLOCKs): identity instability (any cross-domain collision in R3.4), repeat-analysis cache hit rate < 100%, measured cost per analysis above the manifest's declared budget cap.
- Soft weights (combined into the verdict with hard conditions): keyword coverage and coverage ratios must each meet the manifest's declared minimums.

**Rationale**: Spec deliberately does not hard-code numbers ("no false precision"); structural rules ensure thresholds are objective, recorded, and evaluable mechanically — a blocked verdict can be reproduced by re-evaluating frozen evidence (SC-002).

**Alternatives considered**: Fixed constants in code — rejected (per spec note; would be false precision before seeing measurement distribution).

## R5 — How do "gated until READY" mechanics work? (detector/workflow availability)

**Decision**: Gate at the registry/entrypoint level, not by shipping dead code:

- Part B detector exists in code with `detectorKey: "competitor_gap"` but the detection stage consults the verdict ledger and records the detector as `skipped` with reason `G5_NO_READY_VERDICT` unless the latest verdict for the org/project is READY.
- Part C: `competitor_gap` remains excluded from `AUTOPILOT_WORKFLOW_TYPES` (existing test `src/shared/autopilot.test.ts:33` already asserts this structural exclusion as the G5/P36 guard). On READY, the workflow type is added in the same PR as workflow implementation, and that test is updated.
- `intelligence-boundaries.test.ts` vocabulary: the gated detector key and workflow key are added to the allowlist in the same PR that lands them.

**Rationale**: Matches existing G5 precedent (workflow type structurally excluded with a test), P26–P28 no-trigger semantics (skipped ≠ failed ≠ zero), and §2.4-style "boundary test updated in same PR" discipline.

**Alternatives considered**: Feature-flag env var — rejected (verdict must be evidence-backed and per-org, not global). Hiding UI only — rejected (P39 scope; enforcement belongs server-side).

## R6 — Part B detector shape (conditional; only sketched here)

**Decision**: On READY, `competitorGap.ts` follows the established detector contract: pre-fetched inputs (competitor snapshots + GSC/rank coverage via `organicJoin.ts` patterns), pure synchronous `detect`, `FindingDraft` with `evidenceType: "observational"`, `InsufficientCoverageError` for coverage gates, injected thresholds via `thresholds` (never hardcoded). Materializer template emits fact vs recommendation separately (P27). Identity: `findingKey` from (detectorKey, version, entityKey, period) following `strikingDistance.ts` precedent.

**Rationale**: Conformity with 12 existing detectors; boundary tests and materialization idempotency come free with the pattern.

**Alternatives considered**: Detector computes gaps itself from raw provider calls — rejected (P25: detection consumes stored/normalized evidence; P11 cache-first).

## R7 — Part C workflow shape (conditional)

**Decision**: On READY, `competitor_gap` workflow consumes stored competitor-gap opportunities verbatim (frozen evidence refs), step kinds limited to collect/correlate/synthesize, allowlisted tools only, budgets via `autopilotBudgets.ts`, resume/idempotency via existing attempt ledger. Copy goes through `synthesisFirewall.ts` language gates (no causal verbs).

**Rationale**: P34–P36; matches `content_refresh`/`monthly_review` precedent which already consume stored engine output.

## R8 — Cross-package dependencies

**Decision**: Hard dependencies recorded:

- §006 (canonical identity, G1) must pass before Part B joins ship — spike R3.4 measures identity using whatever §006 exposes; if §006 not landed, the spike measures with the current chain and documents the gap.
- §007 cache model (snapshot vs metric freshness, singleFlight) is reused for cache-reuse measurements (R3.5).
- §010 GA4 joins are NOT required for Part B (gap detection needs GSC/rank + competitor snapshots, not GA4).

**Rationale**: Prevents wave-4/5 collision noted in plan §7; keeps 014 unblockable by other packages' completion state where constitutionally unnecessary.

All NEEDS CLARIFICATION resolved: none existed — this research records decisions anchored to existing code paths verified above.

## Recon log (Phase 1, T001–T003, recorded 2026-10-09)

**T001 — §006 canonical identity state**: LANDED. `canonicalUrl()` (`src/shared/intelligence.ts:109`) now handles absolute http(s) URLs (scheme/host preserved, percent-encoding normalized), path-only rows resolved against a project host context without inventing hosts, and unparseable input degrading to deterministic distinct identities. Docblock documents the analytical-join-identity contract (lines 100–108). The spike's identity dimension (T016) measures against the FULL §006 chain — no gap to document.

**T002 — competitor data surfaces** (read paths for spike reuse):

- `src/server/lib/seo-data/competitor-snapshot-repository.ts` — `persistCompetitorSnapshot` (L24), `getLatestCompetitorSnapshot` (L45), `canonicalKeywordKey` (L17). Snapshots scoped `(projectId, keywordKey, locationCode, languageCode)`, rows accumulate, latest wins.
- `src/server/lib/seo-data/data-router.ts:50` — `competitors: ["internal", "dataforseo"]` (free-first; internal serves persisted snapshot, DataForSEO write-throughs on paid fetch).
- `src/server/lib/seo-data/providers/dataforseo-provider.ts` — `competitors` case + write-through (L498–L541).
- `src/server/lib/seo-data/providers/internal-provider.ts` — competitors served from `competitor_snapshots` (L332–364).
- Cost instrumentation: `src/server/lib/seo-data/cost-tracker.ts` (`getCostCounters`, `recordDataforseoCall`, `assertDataforseoBudgetAvailable`); trace: `seo-data/trace.ts` (`traceProviderCall`, `traceCacheDecision`).

**T003 — gate precedent anchors**:

- `src/shared/autopilot.ts:8-15` — `AUTOPILOT_WORKFLOW_TYPES` (six entries; `competitor_gap` absent).
- `src/shared/autopilot.test.ts:33-37` — structural G5/P36 exclusion test to flip only in the READY PR (US3, T031).
- `src/server/features/intelligence/services/detectionStage.ts:40-52,102-124` — detector outcome recording: `skipped` (with `skipReason`) vs `failed` (with `error`); `InsufficientCoverageError` → `skipped` (L109-117). The verdict gate (T027) records `skipped` with `G5_NO_READY_VERDICT` following exactly this pattern.
- Ledger conventions: `src/db/runBatch.ts` (`runBatch` for writes, P4), `src/db/schema.ts` (provider-aware barrel; parity test guards D1/PG interchangeability), `src/db/schema-parity.test.ts` (drift guard; new table must land in BOTH dialect schemas or parity fails).
