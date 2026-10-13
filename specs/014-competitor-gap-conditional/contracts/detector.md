# Contract: competitor_gap Detector (Part B — conditional on READY)

**Status**: Conditional. This contract is inert until a `COMPETITOR_GAP_READY` verdict exists for the project (see spike-and-verdict contract). No code from this contract ships disabled-but-live as a second engine; gating happens at the detection stage via the verdict ledger.

## Detector registration

- `detectorKey`: `"competitor_gap"` (part of finding/opportunity identity)
- `version`: integer, starts at 1; major version supersedes findings, minor updates in place (existing registry conventions)
- Registration: appended to `DETECTORS` in `src/server/features/intelligence/detectors/registry.ts`
- Boundary allowlists (`intelligence-boundaries.test.ts`) updated in the same PR (plan §2.4 discipline)

## Inputs (pre-fetched; detector never reads repositories or providers directly — P11, DetectorContext pattern)

- Competitor snapshots: latest `competitor_snapshots` rows for the project + keyword set + market (internal provider, cache-first; zero uncached paid calls on repeat — SC-004)
- First-party evidence: GSC/rank rows for the same keyword set and window (via `organicJoin.ts` conventions), with coverage ledgers
- Identity context: canonical identity from the §006 chain applied to competitor domains/URLs and project URLs (G1, P24)

## Detection contract

```
detect(ctx, input) -> FindingDraft[]
```

- Pure synchronous over pre-fetched inputs (existing `DetectorDef` contract).
- No-trigger semantics (P28, G9):
  - `InsufficientCoverageError` on FAILED/missing coverage grains → detector recorded `skipped`, never `failed`, never emits findings.
  - Provider-failure inputs (input fetcher failed) → no detection run for this detector this scan; the absence is recorded, distinct from "no gap found".
  - Successful zero-overlap (competitor data present, genuinely no gap) → no findings by threshold logic; distinguishable from failure via coverage flags.
- Finding identity: `findingKey = hash(detectorKey, version, entityKey, periodFrom, periodTo)` following `strikingDistance.ts` precedent; idempotent materialization (re-scan = upsert, zero duplicates).
- Evidence: frozen `metrics` (competitor positions, overlap sets, user-site absence/weakness signals), `periods`, `thresholdsApplied` (injected only — `thresholdNumber`), `evidenceType: "observational"`, provenance classification per P47.
- Scores: `impactScore` and `confidenceScore` computed separately, no collapse (P26); missing optional inputs renormalize available factors rather than reading as zero.
- No fabricated metrics: DataForSEO metric names used accurately (Domain Rank, Page Rank, Referring Domains, Backlinks, Spam/Risk); never DA/PA/DR/TF/CF (P16).

## Boundaries (enforced by tests)

- No raw provider JSON below the service layer; no provider imports from detector modules.
- No causal verbs in `explanationFact`; recommendations only from materializer templates (P27/P46).
- Detector skip state never renders as "no opportunities exist" downstream.

## Test matrix (mandatory; Vitest colocated)

- Triggering cases produce stable, deduplicated findings/opportunities with frozen evidence.
- All no-trigger negatives pass: provider-failure fixture, insufficient-coverage fixture, below-threshold impressions/overlap fixture.
- `findingKey` stability across re-scans; materialization idempotency (0 duplicates).
- Cache: repeat detection inputs resolved → 0 paid provider calls (SC-004).
- Gate: detector recorded `skipped` with `G5_NO_READY_VERDICT` when no READY verdict exists.
- Boundary: registry allowlists and vocabulary tests updated in same PR.
