---
description: "Task list for spec 014 — Competitor-Gap Conditional"
---

# Tasks: Competitor-Gap Conditional Package

**Input**: Design documents from `/specs/014-competitor-gap-conditional/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (3 files), quickstart.md

**Organization**: Tasks are grouped by user story. **G5 gate discipline** (Constitution Principle 36): US1 (spike + verdict ledger) is the only unconditional story. US2 (detector) and US3 (autopilot workflow) phases record their gate upfront and their implementation tasks MUST NOT begin until a `COMPETITOR_GAP_READY` verdict row exists for the executing org/project.

**Hard rules for every phase** (from plan.md Constitution Check):

- Failure never becomes `0`/no-result (P8, P9, G9): provider-failure measurements/readings stay `unavailable`.
- Detector/workflow landing PRs update boundary allowlists and vocabulary tests **in the same PR** (plan §2.4 discipline).
- No new provider, resolver, queue, engine, canonicalizer (P2, P6, P24 P37).
- Quality gates per phase: `pnpm types:check` + `pnpm oxlint` + schema parity where applicable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story phase (US1 = spike→verdict, US2 = detector, US3 = workflow)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify foundations the spike measures against; no scaffolding beyond spec docs (repo already has all shared infrastructure).

- [x] T001 Confirm §006 canonical identity state: read `src/shared/intelligence.ts` (`canonicalUrl()`), `src/shared/ga4.ts` (`normalizeGa4LandingPage`), and `src/server/features/intelligence/services/AnalyticsJoinService.ts`; record in `specs/014-competitor-gap-conditional/research.md` (append to R3.4/R8 note) whether the §006 full host/scheme/encoding chain is landed or the spike measures against the current path-only chain (a documented result either way — research R8).
- [x] T002 [P] Map existing competitor data surfaces for spike reuse and record the exact read paths in `specs/014-competitor-gap-conditional/research.md` (append to R1): `src/server/lib/seo-data/competitor-snapshot-repository.ts` (`persistCompetitorSnapshot`, `getLatestCompetitorSnapshot`), `src/server/lib/seo-data/providers/internal-provider.ts` (competitors case), `src/server/lib/seo-data/providers/dataforseo-provider.ts` (competitors case + write-through), `src/server/lib/seo-data/data-router.ts` (`competitors: ["internal","dataforseo"]`).
- [x] T003 [P] Confirm existing gate precedent to mirror: read `src/shared/autopilot.ts` (`AUTOPILOT_WORKFLOW_TYPES` — `competitor_gap` excluded), `src/shared/autopilot.test.ts` (structural G5/P36 exclusion test), and `src/server/features/intelligence/services/detectionStage.ts` (detector skip recording: `skipped` vs `failed`); cite line anchors in `specs/014-competitor-gap-conditional/research.md` (append to R5).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The append-only verdict ledger and the spike harness scaffolding block all user stories; per data-model.md and contracts/spike-and-verdict.md.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 Add `competitor_gap_verdicts` table to `src/db/app.schema.ts` per data-model.md: columns `id text PK`, `organizationId text FK`, `projectId text FK`, `verdict text` (enum `COMPETITOR_GAP_READY | COMPETITOR_GAP_BLOCKED`), `evidence text (JSON)`, `thresholds text (JSON)`, `inputManifest text (JSON)`, `recordedAt text (ISO)`; index `(organizationId, projectId, recordedAt desc)`; append-only (no product update/delete paths).
- [x] T005 [P] Mirror the identical table to `src/db/pg/app.schema.ts` (Postgres parity — P3) and generate additive migrations under `drizzle/` (D1) and `drizzle-pg/` (PG) per existing migration conventions; extend the schema parity test (`schema-parity.test.ts` or its current location) to cover the new table.
- [x] T006 Create the spike harness module `src/server/lib/competitor-gap/spikeHarness.ts`: accepts a spike input manifest (sampled competitor domains, keyword set ref, market `locationCode`/`languageCode`, `budgetCapCredits`, `timeBoxHours`, pre-registered threshold set per contracts/spike-and-verdict.md), executes the five measurement dimensions from research R3 (quality, coverage, cost, identity, cache), and returns frozen evidence; provider failure during any measurement marks that dimension `unavailable` in evidence — never `0` (P8/P9).
- [x] T007 Create the verdict recorder `src/server/lib/competitor-gap/verdictLedger.ts`: deterministic verdict evaluation per contracts/spike-and-verdict.md (any hard-condition breach → BLOCKED: `identityCollisionsObserved > thresholds.identityCollisionsAllowed`, `repeatCacheHitRate < thresholds.repeatCacheHitRate`, `measuredCreditsPerAnalysis > thresholds.maxCostPerAnalysisCredits`, `keywordCoverageRatio < thresholds.minKeywordCoverageRatio`, `firstPartyCoverageRatio < thresholds.minFirstPartyCoverageRatio`; else READY), then an append-only insert via existing batching helpers (`runBatch`/`executeInBatches` — P4); expose `latestVerdict(organizationId, projectId) -> row | null` for the runtime gate.
- [x] T008 [P] Add Global Trace rows for spike operations (`competitor_gap_spike_measure`, `competitor_gap_verdict_record`) to the trace taxonomy in `src/shared/globalTraceTypes.ts` with secret scrubbing (P41); trace is observability only — the ledger row from T007 is authoritative (P42).

**Checkpoint**: Ledger table + parity + harness + recorder exist; spike can run and persist a verdict.

---

## Phase 3: User Story 1 — Recorded go/no-go verdict on competitor-gap inputs (Priority: P1) 🎯 MVP

**Goal**: A time-boxed spike measures input quality/coverage/cost/identity/cache against a maintainer-declared manifest and records exactly one auditable verdict (`COMPETITOR_GAP_READY` | `COMPETITOR_GAP_BLOCKED`) with frozen evidence.

**Independent Test**: Run the spike over a fixture/recorded sample; verify exactly one verdict row is appended, the verdict equals the deterministic evaluation in contracts/spike-and-verdict.md, failure dimensions read `unavailable` (never `0`), and a repeat spike appends a new row without mutating the previous (quickstart.md Scenarios 1 & 5).

### Tests for User Story 1

> Write these FIRST, ensure they FAIL before implementation (P43).

- [x] T009 [P] [US1] Unit tests for deterministic verdict evaluation in `src/server/lib/competitor-gap/verdictLedger.test.ts`: each hard condition independently flips READY→BLOCKED; all-pass → READY; boundary equality cases decided per contract (strict `<` for ratios, `>` for cost/collisions).
- [x] T010 [P] [US1] Repository tests for the ledger in `src/server/lib/competitor-gap/verdictLedger.test.ts` (or colocated repository test per repo convention): append-only insert (second insert for same manifest+recordedAt does not mutate first row), `latestVerdict` returns most recent per `(organizationId, projectId)`, project-scope isolation (no cross-project reads), D1 semantics used by the parity harness.
- [x] T011 [P] [US1] Spike measurement tests in `src/server/lib/competitor-gap/spikeHarness.test.ts`: (a) recorded/fixture competitor responses yield the evidence shape from contracts/spike-and-verdict.md; (b) provider failure in any dimension marks it `unavailable` — never `0` (P8/P9); (c) identity measurement detects collisions across raw variants (scheme/host/case/trailing-slash/encoding) via the §006 chain; (d) repeat-run cache measurement asserts the second analysis performs 0 paid calls (§007 cache model).
- [x] T012 [P] [US1] Budget-guard test in `src/server/lib/competitor-gap/spikeHarness.test.ts`: the harness refuses to start (or stops) when projected spend exceeds the manifest `budgetCapCredits`; refusal is explicit and recorded — not a silent empty run.

### Implementation for User Story 1

- [x] T013 [US1] Implement dimension measurement 1 — **data quality** in `src/server/lib/competitor-gap/spikeHarness.ts`: for sampled domains over the project keyword set + market, compute `keywordCoverageRatio` and `requiredFieldMissingRate` (position/URL/volume-proxy fields) from DataForSEO Labs competitor rows resolved via the existing data router (`competitors` precedence internal → dataforseo).
- [x] T014 [US1] Implement dimension measurement 2 — **coverage** in `src/server/lib/competitor-gap/spikeHarness.ts`: compute `firstPartyCoverageRatio` for the same keyword set/window from stored GSC/rank evidence (reuse `src/server/features/intelligence/detectors/organicJoin.ts` conventions), emitting the measured `window`.
- [x] T015 [US1] Implement dimension measurement 3 — **cost** in `src/server/lib/competitor-gap/spikeHarness.ts`: consume existing budget/cost trace metadata to compute `measuredCreditsPerAnalysis` and `extrapolatedMonthlyPerProject`; hard-bounded by the manifest budget cap.
- [x] T016 [US1] Implement dimension measurement 4 — **identity stability** in `src/server/lib/competitor-gap/spikeHarness.ts`: compute `collisionsObserved` and `nonDeterministicMappings` by canonicalizing every sampled domain/URL through `canonicalUrl()` (`src/shared/intelligence.ts`) — if §006 is not landed, run against the current chain and record the gap in evidence (T001 result).
- [x] T017 [US1] Implement dimension measurement 5 — **cache reuse** in `src/server/lib/competitor-gap/spikeHarness.ts`: run the same competitor analysis twice over the sample; `repeatAnalysisPaidCalls` must be 0 and `repeatCacheHitRate` computed accordingly.
- [x] T018 [US1] Wire the spike entrypoint in `src/server/lib/competitor-gap/spikeHarness.ts` and (if repo convention requires) a thin server function under `src/serverFunctions/`: manifest in → measurements → verdict evaluation → `verdictLedger` append → verdict + frozen evidence returned to the caller; project/org scope validated (P39); no UI in scope.
- [x] T019 [US1] Emit `competitor_gap_spike_measure` + `competitor_gap_verdict_record` trace rows at harness/recorder integration points (from T008) with counts/duration/cost metadata and no secrets (P41).

**Checkpoint**: Spike runs end-to-end and persists a verdict; quickstart Scenario 1 passes standalone. MVP — this story alone delivers the auditable go/no-go decision.

---

## Phase 4: User Story 2 — Competitor-gap opportunity detection on proven inputs (Priority: P2, conditional)

**Goal**: On `COMPETITOR_GAP_READY`, a `competitor_gap` detector in the existing Intelligence Engine produces stable, deduplicated opportunities with frozen evidence and strict no-trigger semantics (contracts/detector.md).

**⚠️ G5 GATE**: Do not start the detector implementation tasks below until `latestVerdict(organizationId, projectId)` returns READY for the executing context. Until then only test scaffolding may be prepared. The gate test task (T020) intentionally precedes registration.

**Independent Test**: Fixture runs (quickstart Scenario 3): triggering fixtures yield opportunities; failure/coverage fixtures yield none; re-scan yields zero duplicates and zero additional paid calls; without READY, the detector records `skipped` with `G5_NO_READY_VERDICT` (Scenario 2).

### Tests for User Story 2

> Write these FIRST, ensure they FAIL before implementation (P43).

- [x] T020 [P] [US2] Gate test in `src/server/features/intelligence/services/detectionStage.test.ts` (extend): detector present in the registry but recorded `skipped` with reason `G5_NO_READY_VERDICT` when no READY verdict exists for the project; never recorded `failed` for gate absence.
- [x] T021 [P] [US2] Trigger/no-trigger fixture tests in `src/server/features/intelligence/detectors/competitorGap.test.ts`: triggering fixture emits `FindingDraft` with `evidenceType: "observational"`, frozen `metrics` (competitor positions, overlap sets, user-site absence/weakness signals), `periods`, `thresholdsApplied` populated exclusively from injected thresholds; no-trigger fixtures (provider-failure input, insufficient coverage via `InsufficientCoverageError`, below-threshold overlap) emit zero findings.
- [x] T022 [P] [US2] Identity/idempotency test in `src/server/features/intelligence/detectors/competitorGap.test.ts`: `findingKey` stable across re-scans from `(detectorKey, version, entityKey, periodFrom, periodTo)` per `strikingDistance.ts` precedent; materialization re-run upserts — 0 duplicate opportunities (SC-004).
- [x] T023 [P] [US2] Cache-boundedness test in `src/server/features/intelligence/detectors/competitorGap.test.ts`: repeat input resolution over unchanged inputs performs 0 paid provider calls (instrumented via the seo-data router; SC-004).
- [x] T024 [P] [US2] Materialization language test in `src/server/features/intelligence/services/materializeFinding.test.ts` (extend for `competitor_gap`): `explanationFact` contains fact only; recommendation text comes only from the materializer template (P27); no causal verbs (P46).

### Implementation for User Story 2

- [x] T025 [US2] Create `src/server/features/intelligence/detectors/competitorGap.ts` implementing `DetectorDef`: `detectorKey: "competitor_gap"`, `version: 1`, required sources/coverage declared, pure synchronous `detect(ctx, input)` over pre-fetched inputs (competitor snapshots via internal provider + GSC/rank coverage via `organicJoin.ts` patterns) — detector code performs no repository or provider reads (P11).
- [x] T026 [US2] Add `competitor_gap` thresholds to `src/shared/intelligence-thresholds.ts` consumed via `thresholdNumber` only (missing threshold = loud config error, never silent default).
- [x] T027 [US2] Wire the verdict gate in `src/server/features/intelligence/services/detectionStage.ts`: before running `competitor_gap`, consult `latestVerdict` (from T007); record `skipped` with `G5_NO_READY_VERDICT` unless READY.
- [x] T028 [US2] Register the detector in `src/server/features/intelligence/detectors/registry.ts` and **in the same PR** update boundary/vocabulary allowlists in `src/server/features/intelligence/intelligence-boundaries.test.ts` (plan §2.4 discipline — failing do the test first so the PR starts red).
- [x] T029 [US2] Add the materializer template for `competitor_gap` in `src/server/features/intelligence/services/opportunityTemplates.ts`: fact/recommendation split, provenance classification labels (`THIRD_PARTY_ESTIMATE` / `SERP_OBSERVED` per P47), accurate provider metric names only (P16: Domain Rank / Page Rank / Referring Domains / Backlinks / Spam-Risk — never DA/PA/DR/TF/CF).
- [x] T030 [US2] Verify `impactScore`/`confidenceScore` remain separate with available-factor renormalization on missing optional inputs in the materialized opportunity (P26) — extend `src/server/features/intelligence/services/materializeFinding.test.ts` accordingly.

**Checkpoint**: Quickstart Scenarios 2 & 3 pass; detection is gated, deterministic, deduplicated, zero-repeat-cost, and truthfully worded.

---

## Phase 5: User Story 3 — Competitor-gap autopilot workflow on frozen evidence (Priority: P3, conditional)

**Goal**: On READY + stored opportunities, a `competitor_gap` workflow orchestrates over frozen evidence with bounded steps, resume, and language-firewalled output (contracts/autopilot-workflow.md).

**⚠️ G5 GATE**: Same verdict gate as Phase 4, plus Phase 4 must be complete — the workflow consumes stored opportunities; it computes nothing itself (P34).

**Independent Test**: E2E start → poll → resume over pinned evidence fixtures with zero run-time paid calls; all sampled outputs pass `synthesisFirewall` gates (quickstart Scenario 4); inputs absent → explicit empty state ("no stored competitor-gap opportunities"), never fabricated gaps.

### Tests for User Story 3

> Write these FIRST, ensure they FAIL before implementation (P43).

- [x] T031 [P] [US3] Workflow allowlist/boundary test: update `src/shared/autopilot.test.ts` — the existing G5/P36 structural exclusion assertion is flipped to membership **only in this PR**, with a comment recording the READY verdict reference (plan §2.4 discipline; mirror in `src/server/mcp/tools/autopilot-run-tools.test.ts` and the schema-level cases).
- [x] T032 [P] [US3] E2E test in `src/server/features/autopilot/services/autopilotWorkflows.test.ts` (or its E2E home): start → poll → resume for `competitor_gap` over pinned evidence fixtures completes with durable step history; resume replays without duplication; 0 paid provider calls during the run (SC-006).
- [x] T033 [P] [US3] Language-gate test in `src/server/features/autopilot/services/synthesisFirewall.test.ts` (extend): sampled `competitor_gap` outputs contain no causal verbs and no invented rankings/gaps/uplift figures (P27/P46); empty-evidence runs produce the explicit empty-state text, not inferred conclusions.
- [x] T034 [P] [US3] Failure-semantics test in `src/server/features/autopilot/services/stepExecutor.test.ts` (extend): mid-run failure + resume replays from the step ledger; terminal statuses never double-emit summaries; failed runs surface as failed with reason — never as "no gaps" output.

### Implementation for User Story 3

- [x] T035 [US3] Add `"competitor_gap"` to `AUTOPILOT_WORKFLOW_TYPES` in `src/shared/autopilot.ts` plus entries in `AUTOPILOT_WORKFLOW_LABELS` / `AUTOPILOT_WORKFLOW_DESCRIPTIONS` (observational wording, no uplift promises).
- [x] T036 [US3] Implement the workflow definition in `src/server/features/autopilot/services/autopilotWorkflows.ts` + content section in `src/server/features/autopilot/services/autopilotWorkflowContent.ts`: step kinds limited to `collect`/`correlate`/`synthesize` (no `side_effect`); inputs consumed via FindingService/OpportunityService stored reads; `sourceEvidenceRef` pins the frozen findings snapshot the run operates over.
- [x] T037 [US3] Enforce budgets via `src/server/features/autopilot/services/autopilotBudgets.ts` and step executor guards (`stepExecutor.ts`): bounded steps/tool calls, allowlisted tools only, idempotent re-entry, resumable attempts (P35).
- [x] T038 [US3] Route synthesized output through `src/server/features/autopilot/services/synthesisFirewall.ts` language gates before emission (P27/P46).

**Checkpoint**: Quickstart Scenario 4 passes end-to-end; workflow is bounded, resumable, language-safe, and provably free of run-time paid calls.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T039 [P] Run the full quickstart.md validation suite (Scenarios 1–5) against the assembled package and record results in `specs/014-competitor-gap-conditional/quickstart.md` (append a validation-log section).
- [x] T040 [P] Quality gates: `pnpm types:check` + `pnpm oxlint` green; schema parity green for `competitor_gap_verdicts` (P45); document any externally-blocked live smoke per Constitution Appendix C (READY-with-external-blocker rules).
- [x] T041 Extend `intelligence-boundaries.test.ts` final sweep: confirm no parallel canonicalizer/engine/provider imports introduced by this package (P2/P24); confirm raw-token/credential vocabulary absent from public surfaces (P38/P40 — defense-in-depth, nothing in this package shares publicly).
- [x] T042 Documentation: record the executed spike manifest, verdict, and evidence pointer (ledger row id) in `specs/014-competitor-gap-conditional/` (append to research.md or a new `verdict-log.md`) so future reviewers can audit without re-running (SC-002).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **US1 (Phase 3)**: Foundational → unconditional; produces the program's go/no-go artifact.
- **US2 (Phase 4)**: Foundational + **US1 verdict = READY** (G5). Hard stop otherwise.
- **US3 (Phase 5)**: Foundational + US2 complete + verdict READY.
- **Polish (Phase 6)**: After whichever story phases actually shipped (BLOCKED verdict → Phase 6 applies to ledger/harness only).

### User Story Dependencies

- **US1 (P1)**: Independent; no other story may block it (plan §3 note — a BLOCKED verdict halts only this package, never 001–013).
- **US2 (P2)**: Hard dependency on US1 verdict READY; §006 (G1) required for cross-source identity — measured/documented by spike if not landed (T001/T016); §010 GA4 joins explicitly NOT required (research R8).
- **US3 (P3)**: Depends on US2 (consumes its stored opportunities) and the workflow allowlist change landing in the same PR as T031 (T035).

### Within Each User Story

- Tests first (T009–T012, T020–T024, T031–T034) — FAIL before implementation (P43).
- Gate/registration discipline: T020 before T028; T031 before T035 — boundary/allowlist tests lead their landing PRs.
- Detector (T025–T026) before stage wiring (T027) before registry + materializer (T028–T030).
- Workflow definition (T036) before budgets/executor wiring (T037) before firewall routing (T038).

### Parallel Opportunities

- Phase 1: T001, T002, T003 — all [P] (read-only recon, separate files).
- Phase 2: T005 and T008 [P] alongside T004/T006/T007 sequence (T007 consumes T004 schema; T006 consumed by T018).
- US1 tests T009–T012 — all [P] (separate test concerns).
- US1 measurements T013–T017 — mostly sequential within `spikeHarness.ts` (same file); parallelizable only if split into per-dimension helper modules (optional).
- US2 tests T020–T024 — all [P].
- US3 tests T031–T034 — all [P].
- Phase 6: T039, T040 [P].

---

## Parallel Example: User Story 1

```text
# Launch all US1 test tasks together (write-first, must fail):
Task: "Unit tests for deterministic verdict evaluation in src/server/lib/competitor-gap/verdictLedger.test.ts"
Task: "Repository tests for the ledger (append-only, latestVerdict, scope isolation)"
Task: "Spike measurement tests in src/server/lib/competitor-gap/spikeHarness.test.ts"
Task: "Budget-guard test for budgetCapCredits refusal"
```

## Parallel Example: User Story 3

```text
# Launch all US3 test tasks together:
Task: "Allowlist/boundary test flip in src/shared/autopilot.test.ts"
Task: "E2E start → poll → resume in autopilotWorkflows test home"
Task: "Language-gate extension in synthesisFirewall.test.ts"
Task: "Resume/failure semantics in stepExecutor.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only — genuinely the program deliverable)

1. Phase 1 (recon) → Phase 2 (ledger + harness foundation).
2. Phase 3 (US1) → spike executes, verdict recorded.
3. **STOP**: If BLOCKED — package dismissed per spec; Phase 6 polish applies to the ledger/harness only; zero effect on packages 001–013. If READY — US2/US3 unlock and proceed in order.

### Incremental Delivery

1. Setup + Foundational → verdict ledger exists as infrastructure even before the spike runs.
2. US1 → auditable go/no-go (MVP).
3. US2 (only on READY) → gated detector + materializer in one landing PR set with boundary tests leading.
4. US3 (only on READY) → workflow with allowlist flip + firewall, one landing PR.

### Notes

- Every phase that ships code is one PR-sized increment; boundary/vocabulary test updates ride the same PR as the key they allowlist (§2.4 discipline).
- Detector/workflow keys are identity-bearing — once a `findingKey` exists in production data, detector `version` bumps follow registry major/minor rules, never silent rewrites.
- Commit after each task or logical group; stop at any checkpoint to validate the story independently.
