# Quickstart Validation: Competitor-Gap Conditional (spec 014)

Runnable validation scenarios proving this package works end-to-end. References: [data-model.md](./data-model.md), [contracts/spike-and-verdict.md](./contracts/spike-and-verdict.md), [contracts/detector.md](./contracts/detector.md), [contracts/autopilot-workflow.md](./contracts/autopilot-workflow.md).

## Prerequisites

- Package 006 (canonical identity, G1) landed for Part B detection work; spike can run against the current chain and document gaps if not.
- §007 cache model available for cache-reuse measurement.
- Existing quality gates green: `pnpm types:check`, `pnpm oxlint`.

## Scenario 1 — Spike produces a recorded verdict (Part A; unconditional)

**Setup**: Declare a spike input manifest (sampled competitor domains, keyword set, market, budget cap, pre-registered thresholds) as per the spike-and-verdict contract.

**Run**: Execute the spike harness over the recorded sample (fixtures or bounded live run with declared budget cap): `pnpm test` for spike measurement units; spike execution command added by the spike tasks (see tasks.md once generated).

**Expected**:

1. Exactly one verdict row appended to `competitor_gap_verdicts` — never an update, never a duplicate for the same manifest + recordedAt.
2. Verdict equals the deterministic evaluation in the spike-and-verdict contract against frozen evidence.
3. A dimension failing measurement (provider failure) reads `unavailable` in evidence — never `0` — and marks the verdict BLOCKED.
4. Repeat spike over identical inputs yields a new row, previous row unchanged (SC-003 auditability; reviewable from frozen evidence alone in under 15 minutes).

## Scenario 2 — Gate holds without READY verdict

**Setup**: Ensure no READY `competitor_gap_verdicts` row for the test project.

**Run**: Intelligence scan for the project with the detector present (Part B code landed): `pnpm test` detector gate cases (per contracts/detector.md test matrix).

**Expected**:

1. Detector recorded `skipped` with reason `G5_NO_READY_VERDICT` — not `failed`, not silent.
2. Zero findings, zero opportunities created.
3. `competitor_gap` remains excluded from `AUTOPILOT_WORKFLOW_TYPES` before the READY PR (existing structural test stays green).

## Scenario 3 — Detector on READY (Part B; conditional)

**Setup**: Seed a READY verdict row for the fixture project plus fixture competitor snapshots and first-party coverage rows.

**Run**: `pnpm test` trigger/no-trigger fixtures; then a repeat run over identical inputs.

**Expected**:

1. Triggering fixtures produce stable findings/opportunities with frozen evidence, `impactScore`/`confidenceScore` separate, provenance classified.
2. Re-scan upserts by `findingKey`: 0 duplicate opportunities (SC-004).
3. Repeat input resolution: 0 additional paid provider calls (SC-004 cache check via bounded call-count assertions in tests).
4. Failure/insufficient-coverage fixtures: 100% no findings, no opportunities (SC-005).

## Scenario 4 — Workflow over frozen evidence (Part C; conditional)

**Setup**: READY verdict row + stored competitor-gap opportunities (from Scenario 3 fixtures).

**Run**: Autopilot E2E start → poll → resume for `competitor_gap` over pinned evidence fixtures.

**Expected**:

1. Run completes with durable step history; resume replays without duplication.
2. Zero run-time paid provider calls (SC-006).
3. Sampled outputs pass synthesisFirewall language gates: 100% causal-claim-free, no invented metrics (SC-006).
4. Inputs absent → explicit empty state ("no stored competitor-gap opportunities"), never fabricated gaps.

## Scenario 5 — BLOCKED verdict halts only this package

**Setup**: Seed a BLOCKED verdict row.

**Run**: Attempt detection/workflow paths; run unrelated package test suites.

**Expected**: Parts B/C inert for this project; packages 001–013 test suites unaffected (zero cross-package blocks — spec SC-003).

## Quality gates

- `pnpm types:check` green
- `pnpm oxlint` green
- D1/PG schema parity tests green for `competitor_gap_verdicts`
- Boundary tests updated and green in the same PRs that land detector/workflow keys
