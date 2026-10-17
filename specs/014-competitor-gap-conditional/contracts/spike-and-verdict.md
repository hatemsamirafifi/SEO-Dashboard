# Contract: Spike Harness ↔ Verdict Ledger (Part A)

**Status**: Unconditional — ships with the spike regardless of verdict.

## Purpose

Define the interface between the competitor-gap input spike, the durable `competitor_gap_verdicts` ledger, and the runtime gate that conditions Part B/C availability.

## Spike input manifest (declared before execution)

```json
{
  "organizationId": "string",
  "projectId": "string",
  "sampleDomains": ["competitor-a.com", "competitor-b.com"],
  "keywordSetRef": "string (existing saved/set ref used for find_serp_competitors sampling)",
  "market": { "locationCode": 2840, "languageCode": "en" },
  "budgetCapCredits": "number",
  "timeBoxHours": "number",
  "thresholds": {
    "minKeywordCoverageRatio": "number",
    "minFirstPartyCoverageRatio": "number",
    "maxCostPerAnalysisCredits": "number",
    "repeatCacheHitRate": "number (must equal 1.0 to pass)",
    "identityCollisionsAllowed": "number (must equal 0 to pass)"
  }
}
```

Thresholds are pre-registered here (research R4); they are never edited after execution begins.

## Measured evidence shape (frozen into ledger row)

```json
{
  "quality": {
    "keywordCoverageRatio": "number",
    "requiredFieldMissingRate": "number"
  },
  "coverage": {
    "firstPartyCoverageRatio": "number",
    "window": { "from": "ISO-date", "to": "ISO-date" }
  },
  "cost": {
    "measuredCreditsPerAnalysis": "number",
    "extrapolatedMonthlyPerProject": "number"
  },
  "identity": {
    "collisionsObserved": "number",
    "nonDeterministicMappings": "number"
  },
  "cache": {
    "repeatAnalysisPaidCalls": "number",
    "repeatCacheHitRate": "number"
  }
}
```

## Verdict evaluation (deterministic)

```
BLOCKED if any:
  identity.collisionsObserved > thresholds.identityCollisionsAllowed
  cache.repeatCacheHitRate < thresholds.repeatCacheHitRate
  cost.measuredCreditsPerAnalysis > thresholds.maxCostPerAnalysisCredits
  quality.keywordCoverageRatio < thresholds.minKeywordCoverageRatio
  coverage.firstPartyCoverageRatio < thresholds.minFirstPartyCoverageRatio
else READY
```

One verdict per spike run, appended to `competitor_gap_verdicts` (data-model.md). Trace emits observability rows; the ledger row is authoritative (P42).

## Runtime gate contract (consumed by Part B/C)

```
latestVerdict(orgId, projectId) -> verdict row | null
gateState = null → NO_VERDICT | verdict=BLOCKED → BLOCKED | verdict=READY → READY
```

- Detection stage (intelligence): when gating `competitor_gap`, record detector as `skipped` with reason `G5_NO_READY_VERDICT` unless gateState=READY.
- Autopilot: `competitor_gap` not in `AUTOPILOT_WORKFLOW_TYPES` until the READY PR adds it (structural guard R5).

## Failure semantics (P8/P9/P28)

- Provider failure during spike measurements marks that dimension `unavailable` in evidence (never `0`); a dimension measured as unavailable makes the verdict BLOCKED with the reason recorded.
- Successful zero-result measurements (e.g., competitor genuinely ranks for nothing) are valid `0` values, distinct from `unavailable`.
