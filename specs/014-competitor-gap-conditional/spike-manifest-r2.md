# Spike Manifest R2: Competitor-Gap Input Spike (spec 014, Part A — Re-evaluation)

**Status**: DRAFT (Pending DataForSEO provider recovery and preflight verification)  
**Evaluation ID**: `competitor-gap-g5-r2`  
**Run Identity**: `spike-manifest-r2`  
**Declared**: 2026-10-15

## Provenance

Previous evaluation (preserved permanently and immutably):

- **ledgerRowId**: `cgv_4c878e65_2026-10-14T20:09:49.856Z`
- **verdict**: `COMPETITOR_GAP_BLOCKED`
- **reason**: Provider-dependent quality and cache dimensions unavailable due to temporary DataForSEO account access pause.
- **disposition**: Authoritative historical evidence. Not superseded, deleted, or reinterpreted.

## Purpose

Competitor Gap G5 re-evaluation after DataForSEO provider recovery.

## 1. Representative project

- **Project**: powersiment.ae (`bb267736-5e5e-9f5f-7d78260abbde`)
- **Rationale**: Real GSC coverage (clicks + impressions across topical Arabic queries, trailing 28-day window verified), real demand, coherent academic-services niche, discoverable competitors.
- **Market**: `locationCode: 2784`, `languageCode: "ar"` (project default).

## 2. Competitor set (frozen sample)

1. `emtyiaz.com`
2. `manaraa.com`
3. `bahthy.com`

Source: Ranking sites in the same Arabic academic-services query space, discovered via web search 2026-10-09 (zero paid calls).

## 3. Keyword/query sample (frozen reference)

- **keywordSetRef**: `gsc-top-queries-2026-10-09`
- Top-10 powersiment.ae GSC queries by impressions (last 28d, verified free via Search Console, no paid spend):
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

- Trailing 28-day window ending at spike execution time (harness-derived; `fetchFirstPartyCoverageRatio` reads stored `gsc_search_performance` summary grain only — G10, no live provider reads).

## 5. Provider / budget ceiling

- **budgetCapCredits**: 500 (projected spend: 3 domains × 2 fetches = 6).
- Paid work only through the seo-data router (`domain_keywords`, internal → dataforseo) plus its own budget guards (P12, defense in depth).
- **timeBoxHours**: 4.

## 6. Cache-repeat measurement conditions

- Repeat the competitor analysis for the first sampled domain (`emtyiaz.com`); the second pass must be served with `repeatAnalysisPaidCalls = 0` (`repeatCacheHitRate = 1.0`).

## 7. Identity-stability sample

- 6 raw variants per sampled domain (apex/trailing-slash, uppercase scheme+host, `www` subdomain, path, path+query) canonicalized through the §006 `canonicalUrl()` chain; collisions counted ACROSS domains only.

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

Hard BLOCK on: any `unavailable` dimension (P8/P9), any cross-domain collision, any non-determinism, any repeat paid call, cost over cap, either coverage ratio below minimum.

## 9. Execution (operational — maintainer-run)

- Maintainer invocation through authenticated Project Settings Developer Tools surface (`Evaluation: Competitor Gap G5 R2`).
- Requires:
  1. Preflight PASS: DataForSEO connection, health, circuit closed, budget available, and bounded probe success.
  2. Explicit maintainer confirmation.
  3. Input manifest frozen with `evaluationId: "competitor-gap-g5-r2"`.

## 10. Verdict log (filled AFTER execution — T042)

(Empty until real execution completes)
