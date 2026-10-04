# Contract: Organic Page Join

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
**Extends**: `AnalyticsJoinService.joinUrlEvidence` (pure scan-time join — "nothing persisted",
final-plan §9.6). No second join system (P2); join keys exclusively via the 006 canonical identity
(P24/G1).

## Function signature (extended, additive)

```ts
joinUrlEvidence(input: {
  gsc?: JoinGscPage[];                     // { url, clicks, impressions }        (existing)
  ga4?: JoinGa4Page[];                      // extended below                      (extended)
  rank?: JoinRankPage[];                    // { url, worsened }                   (existing)
  hostContext?: string | null;               // spec 006 host resolution           (existing)
}): JoinedUrlRow[]
```

## Input row types

```ts
JoinGa4Page = {
  landingPage: string;                      // path-only or absolute (existing)
  currentSessions: number;
  previousSessions: number;
  // 010 additions (additive; callers pre-fetch from stored grains):
  currentEngagedSessions?: number;
  previousEngagedSessions?: number;
  currentGoalConversions?: number;           // per goal binding (R1), additive event sums
  previousGoalConversions?: number;
}
```

Optional-with-absence semantics: a missing optional field on a row means "no coverage for that
measure" → output null, never 0 (P9). This lets callers pass sparse rows from partial coverage
without zero-fabrication.

## Output row type

```ts
JoinedUrlRow = {
  url: string;                              // canonical identity (006 rules)
  gscClicks: number | null;
  ga4Sessions: { current: number; previous: number } | null;
  rankWorsened: boolean | null;
  present: { gsc: boolean; ga4: boolean; rank: boolean };
  // 010 additions:
  ga4Engagement: {
    currentRate: number;                     // engagedSessions/sessions, ratio-of-sums
    previousRate: number;
    currentEngagedSessions: number;
    previousEngagedSessions: number;
  } | null;                                  // null when GA4 absent or sessions=0 denominator
                                             // (0/0 is undefined engagement → null, not 0)
  ga4GoalConversions: { current: number; previous: number } | null;
}
```

## Binding rules

1. **Purity**: the function imports no repositories (existing import-ban test stays green); all rows
   are pre-fetched by caller fetchers; join is deterministic and order-independent (sorted output by
   canonical url, existing `toSorted`).
2. **Identity**: every source row keys through `canonicalUrl(value, hostContext)`; raw variants
   collapsing to one identity merge into one row; `(not set)` never joins anything (006 contract
   fixture pairs are the regression suite — extended, not replaced).
3. **Presence vs zero**: a source contributing no row for a page leaves `present.* = false` and its
   metrics `null`; a source contributing rows is `present` even when values are 0 — 0 remains a valid
   measured zero (P9).
4. **Coverage**: `summarizeJoinCoverage` (existing) extends to count ga4Engagement/goal coverage for
   consumer gating; detectors and UI mark per-source availability from these booleans.
5. **Correlational wording**: consumers rendering join rows use "alongside/observed with" language —
   never causal verbs (P46); per-metric provenance classification is carried by the consumer view
   models from source names (P47).
6. **Bounded**: callers batch pre-fetches (existing detector fetcher conventions); the pure function
   itself is O(rows); no unbounded in-memory cross-source growth (scale edge case, spec).

## Consumer agreement (G1 record dependency)

- Detector fetchers (`conversion_drop`, `engagement_drop`) and the analytics page-join read consume
  this function's output — entity keys in findings are the same canonical urls the join produced
  (cross-consumer agreement test extends the 006 fixture suite).
- The existing boundary test (`intelligence-boundaries.test.ts` import bans) extends to forbid: any
  module outside `AnalyticsJoinService` performing cross-source url joins; any file outside the 006
  allowlist defining URL folding.

## Test matrix (must-pass fixtures)

- must-join pairs from the 006 contract (all three sources collapsing to one row);
- must-not-join pairs (subdomain/port/case/cross-domain stay distinct rows);
- GSC-only page → `present.ga4=false`, ga4 metrics null (no zero-fill);
- GA4 present with sessions=0 → ga4Engagement null (undefined rate), not 0;
- goal conversions present/absent per page independently of engagement;
- order-independence: shuffled inputs → identical sorted output (determinism).