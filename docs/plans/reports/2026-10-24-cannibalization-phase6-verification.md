# Phase 6 - Cannibalization Classification Verification (spec 018)

Date: 2026-10-24
Branch: `feat/p1-cannibalization`
Base: `62a395a5` (wave 3 integration baseline with phases 1-5 merged)
Worktree: `F:\SEO-Dashboard-worktrees\p1-cannibalization`

## A. Repository Assessment

- Extended the existing `cannibalization` detector instead of rebuilding it: the
  same entity key, the same emission bar, the same GSC query_page grain, and the
  same rank-tracking corroborator. No new detector, table, provider, endpoint, or
  route.
- Reused the repository's existing GSC coverage semantics
  (`GscSearchPerformanceRepository.hasCoverage`, sync intervals, zero-row days)
  rather than inventing a new coverage rule.
- Kept the repo's fact/recommendation split: the detector emits the tier and the
  observed evidence; the materializer template owns the recommendation wording.
- Confirmed gaps: no E2E fixture flag exists for opportunities, so the
  classification badge is covered by unit tests and the pure copy helpers (the
  repo's own spec-010 note records that detector-emitted opportunity flows stay
  seed-dependent until such a flag exists); the Postgres side is untouched
  because there is no schema change.

## B. Implementation Status

| Deliverable                                 | Status   | Evidence                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classification tiers                        | COMPLETE | `cannibalizationClassification.ts`: `classifyCannibalization` returns exactly one of `POSSIBLE_CANNIBALIZATION`, `INTENT_DISTINCT`, `NORMAL_URL_DIVERSITY`, `NEEDS_REVIEW`, `INSUFFICIENT_DATA`; the tier travels in `entity.classification`, `evidence.metrics.classification`, and `coverageFlags.classification` |
| Historical query->page shift                | COMPLETE | `cannibalizationInput.ts` reads the immediately preceding window of the same length via `splitWindows`, records the URLs that served the query then, and derives `shiftedIn` / `shiftedOut`; a shift is only asserted when that window is covered                                                                   |
| Coverage integrity                          | COMPLETE | A window is covered when the sync ledger covers it (`hasCoverage`, empty days included) or its stored fact days reach `minCoverageRatio`; an uncovered window throws `InSUFFICIENT_COVERAGE` instead of being read as "no overlap"; row counts never decide coverage                                                |
| Evidence cap                                | COMPLETE | `maxEvidenceRows` (200) is an injected threshold, echoed in `thresholdsApplied`, and never influences the tier                                                                                                                                                                                                      |
| Tier-aware, non-destructive recommendations | COMPLETE | `opportunityTemplates.ts` maps each tier to a title and a recommendation; the wording offers consolidation / canonical review / intent differentiation, confirmation, review-before-change, or re-sync - never deletion or redirection                                                                              |
| Opportunity surface                         | COMPLETE | `opportunitiesCopy.ts` adds the tier labels and badge classes plus the pure `classificationFromMetrics` / `metricRowsForEvidence` helpers; `OpportunityDetailSections.tsx` renders the tier badge and drops the raw metric row                                                                                      |
| Threshold and detector versioning           | COMPLETE | `THRESHOLD_VERSION` 4 -> 5 (`dominantShare`, `intentOverlapMax`, `maxEvidenceRows`); `cannibalizationDetector.version` 1 -> 2 so tier-aware opportunities supersede the previous ones                                                                                                                               |
| Boundary locks                              | COMPLETE | The new detector modules are listed in `DETECTOR_FILES`, so the observational causality lock and the locked-token surface cover them; the single page-identity helper rule still holds                                                                                                                              |

## C. Crawler Verification

Not applicable; Phases 1-3 remain unchanged and are covered by
`docs/plans/reports/2026-10-23-crawler-milestone-verification.md`. Phase 6 reads
stored GSC facts only and never touches the crawl.

## D. Feature Verification

- One tier per candidate: the classification helper is a single ordered decision
  over observed facts, and every emitted finding carries the same tier in the
  entity, the metrics, and the coverage flags.
- Observed-only: the tier uses per-URL impressions, the impression split, the
  observed query-set overlap, and the previous window's serving URLs. No intent
  is asserted beyond what the stored facts show.
- Historical shift: `shiftedIn` / `shiftedOut` come from comparing the current
  and previous windows; when the previous window is not covered the finding
  carries `prior_window_not_covered` and no shift is claimed.
- Coverage integrity: an unsynced window with a low day ratio is skipped with
  `INSUFFICIENT_COVERAGE`; a synced window with empty days is analyzed; a failed
  sync contributes no coverage interval, so its range is never read as "no
  overlap".
- Non-destructive recommendations: every tier's recommendation is a review or
  consolidation suggestion; the template test asserts no causal verb and no
  delete/redirect/remove wording.
- Determinism: tier, ordering, and prose depend only on stored facts and
  injected thresholds.
- Authorization and surface: no new endpoint, so the existing project-scoped
  opportunity surface and its authorization test still cover the feature.

## E. Test Results

- `pnpm test:ci` (full suite): 339/340 files passed; 3314 passed, 3 skipped,
  1 failed. The sole failure is
  `src/server/features/rank-tracking/services/livePausedAccountCheck.test.ts`
  (live DataForSEO API test; its `loadLocalEnv()` reads `.env.local`/`.env`,
  absent in this worktree). Pre-existing and unrelated to cannibalization.
- New/updated targeted suites: `cannibalization.test.ts` (12),
  `cannibalizationInput.test.ts` (6), `opportunityTemplates.test.ts` (19),
  `opportunitiesCopy.test.ts` (18), `intelligence-boundaries.test.ts` (19),
  `detectorInputs.test.ts` (25), `registry.test.ts` (6), `shared/intelligence`
  (43) - all green.
- `pnpm types:check` (`tsc --noEmit`): clean.
- `pnpm lint` (`oxlint . --type-aware`): 0 warnings, 0 errors on 1334 files.
- Prettier: all changed files formatted. Repo-wide `prettier --check .` still
  fails on Windows checkouts because `core.autocrlf=true` rewrites LF to CRLF
  (same failure as the untouched main worktree; logged in
  `.agents/PAPERCUTS.md`).
- `pnpm knip`: no cannibalization findings after un-exporting five
  internal-only symbols; the remaining 3 unused files, 224 unused exports, and
  4 duplicate exports are pre-existing.
- `pnpm build` (client + SSR + `tsc`): green.
- Playwright: not run for this phase - no new route, and the opportunity-detail
  flow is seed-dependent (the repo's own spec-010 note). The existing
  opportunities, audit, and dashboard specs are unaffected by the change.

## F. Cost & Security Review

- No new paid provider, network read, table, background job, or endpoint. The
  detector reads the `gsc_search_performance` rows it already read, plus one
  bounded read of the preceding window of the same grain.
- Memory stays bounded: the per-URL query sets are limited to the window's
  facts, evidence ids are capped by the injected threshold, and the candidate
  set stays proportional to the window's query count.
- No new data is exposed: the tier and the evidence are stored on the existing
  finding and rendered inside the existing project-scoped opportunity surface.
- No secrets or credentials were added; the new unit tests use synthetic facts.

## G. Remaining Risks & Next Steps

1. The tier thresholds are reasoned priors. The first production scans should
   log the near-miss distribution before they are recalibrated; the thresholds
   are injected and echoed in evidence, so recalibration needs no code change.
2. The extra preceding-window read doubles the `query_page` rows read per scan.
   It is bounded by the same window length, but large projects should watch the
   scan duration.
3. A detector version bump supersedes existing cannibalization opportunities
   once, so the first scan after the merge re-materializes them with tier-aware
   titles.
4. When the preceding window was never synced, every candidate carries the
   `prior_window_not_covered` flag and no shift is claimed. That is honest, and
   it is the expected state for projects with less than two windows of GSC
   history.
5. Live-store validation of the tier thresholds remains pending (fixture-only
   acceptance basis).
6. The next wave phase (7, SERP Clustering, spec 019) branches from the
   integration baseline after this phase is merged.
