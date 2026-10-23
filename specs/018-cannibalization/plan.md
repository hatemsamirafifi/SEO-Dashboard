# Implementation Plan: Cannibalization Classification and Historical Shift

**Branch**: `feat/p1-cannibalization` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/018-cannibalization/spec.md`

## Summary

Extend the existing `cannibalization` detector so every candidate receives an
explicit, evidence-backed tier, and so the detector can compare the current window
with the immediately preceding window of stored `query_page` facts. Coverage keeps the
repository's existing GSC semantics (a synced window with empty days is covered; a
window that was never synced or whose sync failed is not covered and never reads as
"no overlap"). Recommendations stay non-destructive and tier-aware. No new table, no
new source, no new provider.

## Technical Context

- **Language/Version**: TypeScript, Node.js runtime (package.json engines), Vite build, Vitest, React 19, TanStack Router/Query/Start.
- **Primary Dependencies**:
  - `src/server/features/intelligence/detectors/cannibalization.ts` - the detector to extend.
  - `src/server/features/intelligence/detectors/gscWindows.ts` - window math and day-presence ratio.
  - `src/server/features/gsc/repositories/GscSearchPerformanceRepository.ts` - `getDailyGrainFacts`, `getLatestFactDate`, `hasCoverage`.
  - `src/shared/intelligence.ts` - shared Zod schemas (finding evidence is strict).
  - `src/shared/intelligence-thresholds.ts` - injected detector thresholds.
  - `src/server/features/intelligence/services/opportunityTemplates.ts` - opportunity title/recommendation.
  - `src/client/features/opportunities/opportunitiesCopy.ts` + `OpportunityDetailSections.tsx` - opportunity surface.
- **Storage**: no schema change. Both dialects untouched; no migration.
- **Testing**: Vitest co-located unit tests; existing intelligence suites (registry, detection stage, detector inputs, boundaries) must stay green; `pnpm test:ci`, `pnpm ci:check`, `pnpm build`.
- **Target Platform**: Cloudflare Workers (D1/Workflows) and Postgres self-host.
- **Project Type**: Web service with server function -> service -> repository layering.
- **Performance Goals**: one extra bounded read of the previous window's `query_page` facts per scan; per-URL query sets capped; evidence ids capped by the injected cap.
- **Constraints**: thresholds injected, never hardcoded; detector emits facts only (recommendations come from the materializer); observational prose (no causal verbs); coverage never inferred from row counts; 400-line file / 320-line function lint limits.
- **Scale/Scope**: one audit-equivalent scan per project per period; candidate count is proportional to the window's query count.

## Constitution Check

- **Project scope / authorization**: no new endpoint or UI route; the existing project-scoped opportunity surface is reused.
- **Dual dialect parity**: no schema change, so no migration and no parity risk.
- **Observed-only**: every tier is derived from stored facts; a missing window is reported as not covered, never as "no overlap".
- **No competing architecture**: the existing detector, thresholds, entity key, template, and opportunity surface are extended in place.
- **Truthfulness**: tiers are labelled verdicts with their evidence; insufficient data is a first-class outcome, not a silent skip.
- **Bounded cost**: one bounded read, capped query sets, capped evidence, no provider calls.
- **Testing**: tier matrix, shift rule, coverage matrix, and no-inference negatives; existing intelligence suites must stay green.

## Design

### 1. Shared classification vocabulary

- `src/shared/intelligence.ts`:
  - `CANNIBALIZATION_CLASSIFICATIONS` (readonly tuple) and
    `cannibalizationClassificationSchema` (`z.enum`) plus the inferred type.
  - Shared so the server detector and the client surface use one vocabulary.

### 2. Thresholds

- `src/shared/intelligence-thresholds.ts`:
  - `cannibalization` gains `dominantShare` (0.8), `intentOverlapMax` (0.2), and
    `maxEvidenceRows` (200).
  - `THRESHOLD_VERSION` 4 -> 5 with a comment naming this change.

### 3. Detector input (extended, not rebuilt)

- `fetchCannibalizationInput`:
  - Keeps the existing anchor (`getLatestFactDate(projectId, "query_page")`).
  - Uses `splitWindows(latestDate, windowDays)` to get the current and previous
    windows instead of computing the current window by hand.
  - Reads the current window's facts as today, plus the previous window's facts.
  - Coverage: `dayRatio = coverageRatio(rows, window)`; `synced = await
hasCoverage(projectId, from, to)`. The window is covered when the sync ledger
    covers it **or** the day ratio reaches `minCoverageRatio`; otherwise the fetcher
    throws `InsufficientCoverageError`. Empty days in a synced window are therefore
    never a gap, and an unsynced window never reads as "no overlap".
  - The previous window is covered by the same rule; `priorCovered` travels with the
    candidate.
  - Per query the fetcher keeps the URL list with per-URL impressions (as today) and
    adds: the observed query set per URL (capped), the overlap coefficient of the two
    top URLs, the previous window's serving URLs, and the shift flags.
  - Evidence ids are capped by `maxEvidenceRows` (the existing 200 becomes an
    injected threshold); the cap never influences classification.

### 4. Classification (pure)

- `classifyCandidate(candidate, thresholds)` in the detector module:
  1. rank-only witness -> `INSUFFICIENT_DATA`;
  2. fewer than `minUrls` URLs above the impression floor -> no finding (emission bar);
  3. previous window not covered -> `partialData: ["prior_window_not_covered"]` and
     no shift-based verdict;
  4. serving URLs changed between windows -> `NEEDS_REVIEW`;
  5. observed query-set overlap at or below `intentOverlapMax` -> `INTENT_DISTINCT`;
  6. impression split at or above `dominantShare` -> `NORMAL_URL_DIVERSITY`;
  7. otherwise -> `POSSIBLE_CANNIBALIZATION`.
- Confidence per tier: possible 70, needs review 55, insufficient data 45, intent
  distinct 40, normal diversity 40 (all at or above the detector's emission gate of
  40, so every tier is visible with its verdict).
- Prose is tier-specific, fact-only, and free of causal verbs.
- The finding carries the tier in `entity.classification`, `evidence.metrics.
classification`, and `coverageFlags.classification`, plus the observed shift and
  overlap numbers.
- `cannibalizationDetector.version` 1 -> 2 (existing opportunities are superseded by
  tier-aware ones).

### 5. Opportunity template

- `opportunityTemplates.ts`:
  - Title per tier (`Possible cannibalization for "q"`, `Distinct-intent overlap for
"q"`, `URL diversity for "q"`, `Overlap needs review for "q"`, `Unclassified
overlap for "q"`).
  - Recommendation per tier; all non-destructive (consolidation / canonical review /
    intent differentiation / confirm / review before change / re-sync or manual
    review). No deletion, redirect, or removal is prescribed.

### 6. Client surface

- `opportunitiesCopy.ts`: tier labels and badge classes, plus a helper that returns
  the label for a stored tier value.
- `OpportunityDetailSections.tsx`: the tier renders as a labelled badge in the
  evidence panel and is excluded from the generic metric rows (no duplicate raw
  value).

### 7. Tests

- `cannibalization.test.ts`: tier matrix (five tiers), shift rule, uncovered prior
  window, emission bar, entity key stability, causal-language guard.
- `opportunitiesCopy.test.ts`: tier label mapping and fallback for unknown values.
- Existing suites must stay green: registry, detection stage, detector inputs,
  intelligence boundaries, shared intelligence.

## Tasks

See [tasks.md](./tasks.md).

## Verification

1. `pnpm types:check`
2. `pnpm exec prettier --check` on changed files
3. `pnpm lint`
4. Targeted Vitest: cannibalization detector, intelligence boundaries, detector
   registry, detection stage, detector inputs, opportunities copy
5. `pnpm test:ci`
6. `pnpm ci:check` (knip / tsc / oxlint steps; repo-wide Prettier is CRLF-blocked on
   Windows checkouts, see `.agents/PAPERCUTS.md`)
7. `pnpm build`
8. `pnpm knip` (new exports)

## Risks

- Tier thresholds are priors: they are injected and echoed in evidence, so the first
  production scans can recalibrate them without a code-path change.
- The extra previous-window read doubles the `query_page` rows read per scan; the
  read is bounded by the same window length and the same grain.
- Classification changes existing opportunity text and confidence, so a detector
  version bump supersedes the previous opportunities once.
- If the previous window is never synced, every candidate carries the
  `prior_window_not_covered` partial-data flag; that is honest, not a defect.
