# Spec 014: Competitor-Gap Spike Verdict Log

**Execution Timestamp**: 2026-10-14T20:09:49.856Z  
**Verdict**: `COMPETITOR_GAP_BLOCKED`  
**Ledger Row ID**: `cgv_4c878e65_2026-10-14T20:09:49.856Z`  
**Target Project**: `powersiment.ae` (`bb267736-5e5e-9f5f-7d78260abbde`)  
**Organization ID**: `delegated-local-admin`

---

## 1. Pre-Registered Manifest & Thresholds

```json
{
  "organizationId": "delegated-local-admin",
  "projectId": "bb267736-5e5e-9f5f-7d78260abbde",
  "sampleDomains": ["emtyiaz.com", "manaraa.com", "bahthy.com"],
  "keywordSetRef": "gsc-top-queries-2026-10-09",
  "market": {
    "locationCode": 2784,
    "languageCode": "ar"
  },
  "budgetCapCredits": 500,
  "timeBoxHours": 4,
  "thresholds": {
    "minKeywordCoverageRatio": 0.5,
    "minFirstPartyCoverageRatio": 0.5,
    "maxCostPerAnalysisCredits": 100,
    "repeatCacheHitRate": 1,
    "identityCollisionsAllowed": 0
  }
}
```

---

## 2. Frozen Evidence (Recorded in `competitor_gap_verdicts`)

```json
{
  "quality": {
    "status": "unavailable",
    "reason": "We noticed some unusual activity in your DataForSEO account, so we’ve temporarily paused access as a precaution. Please, reach out to our support team at support@dataforseo.com for more details, and we’ll work with you to resolve this quickly."
  },
  "coverage": {
    "status": "measured",
    "value": {
      "firstPartyCoverageRatio": 0.9285714285714286,
      "window": {
        "from": "2026-09-16",
        "to": "2026-10-14"
      }
    }
  },
  "cost": {
    "status": "measured",
    "value": {
      "measuredCreditsPerAnalysis": 0.4133600000000003,
      "extrapolatedMonthlyPerProject": 1.6534400000000011
    }
  },
  "identity": {
    "status": "measured",
    "value": {
      "collisionsObserved": 0,
      "nonDeterministicMappings": 0
    }
  },
  "cache": {
    "status": "unavailable",
    "reason": "We noticed some unusual activity in your DataForSEO account, so we’ve temporarily paused access as a precaution. Please, reach out to our support team at support@dataforseo.com for more details, and we’ll work with you to resolve this quickly."
  }
}
```

---

## 3. Dimension-by-Dimension Breakdown

| Dimension                                 | Status        | Value / Measurement                                    | Threshold / Condition               | Result                                                                                |
| ----------------------------------------- | ------------- | ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| **Quality** (Competitor Keyword Coverage) | `unavailable` | Provider paused access (`DataForSEO`)                  | `minKeywordCoverageRatio ≥ 0.50`    | **HARD BLOCK** (Invariant P8/P9: failure is unavailable, never 0; unavailable blocks) |
| **Coverage** (First-Party GSC Window)     | `measured`    | `0.9285714285714286` (~92.9% coverage over 28d)        | `minFirstPartyCoverageRatio ≥ 0.50` | PASS                                                                                  |
| **Cost** (Measured Credits per Analysis)  | `measured`    | `0.4133600000000003` credits                           | `maxCostPerAnalysisCredits ≤ 100`   | PASS                                                                                  |
| **Identity** (Cross-Domain Stability)     | `measured`    | `collisionsObserved: 0`, `nonDeterministicMappings: 0` | `identityCollisionsAllowed = 0`     | PASS                                                                                  |
| **Cache** (Repeat-Analysis Paid Calls)    | `unavailable` | Provider paused access (`DataForSEO`)                  | `repeatCacheHitRate = 1.0`          | **HARD BLOCK** (Invariant P8/P9)                                                      |

---

## 4. Gate Transition and Downstream Invariants

- **Gate Transition**: `NO_VERDICT` → `COMPETITOR_GAP_BLOCKED`
- **Downstream Disposition**:
  - In accordance with Spec 014 Part A discipline, because the verdict is `COMPETITOR_GAP_BLOCKED`, User Story 2 (`competitor_gap` detector) and User Story 3 (`competitor_gap` autopilot workflow) **remain strictly unimplemented**.
  - The competitor-gap package is permanently gated and archived as blocked/dismissed with frozen evidence.
  - Future activation requires declaring a new manifest and executing a new spike run after resolving provider prerequisites.
