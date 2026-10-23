# Tasks: Cannibalization Classification and Historical Shift

**Branch**: `feat/p1-cannibalization` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 1 - Vocabulary and thresholds

- [x] T001 Add `CANNIBALIZATION_CLASSIFICATIONS`, `cannibalizationClassificationSchema`, and the inferred type to `src/shared/intelligence.ts`.
- [x] T002 Add `dominantShare`, `intentOverlapMax`, and `maxEvidenceRows` to the `cannibalization` thresholds in `src/shared/intelligence-thresholds.ts`; bump `THRESHOLD_VERSION` to 5 with a comment.

## Phase 2 - Detector

- [x] T003 Extend `CannibalizationCandidate` in `src/server/features/intelligence/detectors/cannibalization.ts` with observed query sets, the query-set overlap coefficient, previous-window serving URLs, shift flags, and coverage flags.
- [x] T004 Use `splitWindows` and read the previous window's `query_page` facts in `fetchCannibalizationInput`; keep the existing anchor and emission bar.
- [x] T005 Apply existing GSC coverage semantics in the fetcher: a window covered by a completed or partial sync is covered even with empty days; an unsynced window with a low day ratio throws `InsufficientCoverageError`.
- [x] T006 Add the pure `classifyCandidate` helper implementing the five tiers, tier confidence, and tier-specific observational prose.
- [x] T007 Emit the tier in `entity.classification`, `evidence.metrics.classification`, and `coverageFlags`, and record shift/overlap metrics plus partial-data flags.
- [x] T008 Cap evidence ids by the injected `maxEvidenceRows` threshold instead of the hardcoded 200.
- [x] T009 Bump `cannibalizationDetector.version` to 2.

## Phase 3 - Opportunity surface

- [x] T010 Make the cannibalization opportunity title and recommendation tier-aware and non-destructive in `src/server/features/intelligence/services/opportunityTemplates.ts`.
- [x] T011 Add tier labels and badge classes to `src/client/features/opportunities/opportunitiesCopy.ts`.
- [x] T012 Render the tier as a labelled badge in `src/client/features/opportunities/OpportunityDetailSections.tsx` and exclude the raw metric row for it.

## Phase 4 - Tests and gates

- [x] T013 Extend `src/server/features/intelligence/detectors/cannibalization.test.ts` with the five-tier matrix, the shift rule, the uncovered prior window, the emission bar, and the causal-language guard.
- [x] T014 Extend `src/client/features/opportunities/opportunitiesCopy.test.ts` with tier label mapping and unknown-value fallback.
- [x] T015 Run the existing intelligence suites (registry, detection stage, detector inputs, boundaries, shared intelligence) and fix regressions.
- [x] T016 Run `pnpm types:check`, Prettier on changed files, `pnpm lint`, and `pnpm knip`.
- [x] T017 Run `pnpm test:ci` and `pnpm build`.
- [x] T018 Write `docs/plans/reports/2026-10-24-cannibalization-phase6-verification.md`, mark the spec implemented, and commit in atomic slices with `lrc review --skip`.
- [x] T019 Merge `feat/p1-cannibalization` into the integration baseline from a clean worktree.

## Dependencies

- T001-T002 before T003-T009.
- T003-T009 before T010-T012.
- T010-T012 before T013-T014.
- T013-T017 before T018-T019.
