# Spike Manifest: Competitor-Gap Input Spike (spec 014, Part A)

**Status**: FROZEN — declared 2026-10-09, before any spike measurement ran.
**Rule**: Thresholds, sample, and caps below must never be edited after
freezing. If the context proves wrong, declare a NEW manifest (new run);
never mutate this one. Thresholds must never be weakened to force READY.

## 1. Representative project

- **Project**: powersiment.ae (`bb267736-5e5e-9f5f-7d78260abbde`)
- **Rationale**: real GSC coverage (clicks + impressions across topical Arabic
  queries, 2026-09-08→2026-10-06 window verified), real demand, coherent
  academic-services niche, discoverable competitors. Rejected: Lexan Egypt
  (GSC not connected → coverage 0 predetermined → uninformative verdict);
  SMS (thin/junk GSC queries, scattered keyword set).
- **Market**: `locationCode: 2784`, `languageCode: "ar"` (project default).

## 2. Competitor set (frozen sample)

1. `emtyiaz.com`
2. `manaraa.com`
3. `bahthy.com`

Source: ranking sites in the same Arabic academic-services query space,
discovered via web search 2026-10-09 (not via paid calls — zero spike
spend before freezing).

## 3. Keyword/query sample (frozen reference)

- **keywordSetRef**: `gsc-top-queries-2026-10-09`
- Top-10 powersiment.ae GSC queries by impressions (last 28d, verified
  free via Search Console, no paid spend):
  1. اسايمنت (1669 imp)
  2. بحث تخرج (268)
  3. بحث التخرج (246)
  4. اسيمنت (236)
  5. case study بالعربي (196)
  6. رسالة بحث اكاديمي (170)
  7. طريقة كتابة البحث للطلاب (163)
  8. منهج البحث (156)
  9. كيس ستدي (137)
  10. بحث تخرج بكالوريوس (96)

## 4. Required stored-GSC coverage window

- Trailing 28-day window ending at spike execution time (harness-derived;
  `fetchFirstPartyCoverageRatio` reads stored `gsc_search_performance`
  summary grain only — G10, no live provider reads).

## 5. Provider / budget ceiling

- **budgetCapCredits**: 500 (projected spend: 3 domains × 2 fetches = 6).
- Paid work only through the seo-data router (`domain_keywords`,
  internal → dataforseo) plus its own budget guards (P12, defense in depth).
- **timeBoxHours**: 4.

## 6. Cache-repeat measurement conditions

- Repeat the competitor analysis for the first sampled domain
  (`emtyiaz.com`); the second pass must be served with
  `repeatAnalysisPaidCalls = 0` (`repeatCacheHitRate = 1`).

## 7. Identity-stability sample

- 6 raw variants per sampled domain (apex/trailing-slash, uppercase
  scheme+host, `www` subdomain, path, path+query) canonicalized through
  the §006 `canonicalUrl()` chain; collisions counted ACROSS domains only.

## 8. Readiness thresholds (pre-registered)

```json
{
  "minKeywordCoverageRatio": 0.5,
  "minFirstPartyCoverageRatio": 0.5,
  "maxCostPerAnalysisCredits": 100,
  "repeatCacheHitRate": 1.0,
  "identityCollisionsAllowed": 0
}
```

Hard BLOCK on: any `unavailable` dimension (P8/P9), any cross-domain
collision, any non-determinism, any repeat paid call, cost over cap,
either coverage ratio below minimum.

## 9. Execution (operational — maintainer-run)

This sandbox cannot invoke the authenticated server runtime (needs the
app's DB, env, DataForSEO credentials, and real billing context), so
execution is a maintainer step. Exactly one command, against THIS manifest:

1. In the running app (authenticated, org context owning powersiment.ae),
   invoke `runCompetitorGapSpike` with:
   ```json
   {
     "projectId": "bb267736-5e5e-9f5f-7d78260abbde",
     "sampleDomains": ["emtyiaz.com", "manaraa.com", "bahthy.com"],
     "keywordSetRef": "gsc-top-queries-2026-10-09",
     "market": { "locationCode": 2784, "languageCode": "ar" },
     "budgetCapCredits": 500,
     "timeBoxHours": 4,
     "thresholds": {
       "minKeywordCoverageRatio": 0.5,
       "minFirstPartyCoverageRatio": 0.5,
       "maxCostPerAnalysisCredits": 100,
       "repeatCacheHitRate": 1.0,
       "identityCollisionsAllowed": 0
     }
   }
   ```
2. The harness measures → evaluates deterministically → appends ONE row to
   `competitor_gap_verdicts` with frozen evidence (FR-002/FR-003).
3. Poll `getCompetitorGapVerdict` for the recorded verdict.
4. Record the verdict + ledger row id in §10 below, then complete T042.

Expected paid spend: single-digit credits (projection 6; hard cap 500).

## 10. Verdict log (filled AFTER execution — T042)

- Spike executed at:
  2026-10-14T20:09:49.856Z

- Verdict:
  COMPETITOR_GAP_BLOCKED

- Ledger row id:
  cgv_4c878e65_2026-10-14T20:09:49.856Z

- Frozen evidence summary:

  keywordCoverageRatio:
  unavailable
  reason: DataForSEO account access temporarily paused by provider

  firstPartyCoverageRatio:
  0.9285714285714286

  costPerAnalysisCredits:
  0.4133600000000003

  repeatCacheHitRate:
  unavailable
  reason: DataForSEO account access temporarily paused by provider

  repeatAnalysisPaidCalls:
  unavailable
  reason: DataForSEO account access temporarily paused by provider

  identityCollisions:
  0

  identityDeterministic:
  YES

  unavailableDimensions:
  quality, cache

- Gate transition:
  NO_VERDICT → COMPETITOR_GAP_BLOCKED


