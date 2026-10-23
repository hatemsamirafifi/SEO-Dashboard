# Feature Specification: Cannibalization Classification and Historical Shift

**Feature Branch**: `feat/p1-cannibalization`
**Created**: 2026-10-24
**Status**: Implemented - Phase 6 delivered 2026-10-24: the existing `cannibalization` detector now classifies every candidate into one of five tiers (`POSSIBLE_CANNIBALIZATION`, `INTENT_DISTINCT`, `NORMAL_URL_DIVERSITY`, `NEEDS_REVIEW`, `INSUFFICIENT_DATA`), compares the current window against the preceding window of stored `query_page` facts, applies the repository's GSC coverage semantics (a synced window with empty days is covered; an unsynced window is never read as "no overlap"), and emits tier-aware non-destructive opportunity copy plus a classification badge on the opportunity detail. Unit suites, `tsc`, oxlint, and knip show no new findings; the full suite has one pre-existing env-gated live-API failure; `pnpm build` is green (see `docs/plans/reports/2026-10-24-cannibalization-phase6-verification.md`).
**Input**: User description: "Phase 6 of the P1 SEO Intelligence master plan (`docs/plans/2026-10-17-p1-seo-intelligence-implementation.md` section 3.2 row 6): extend `detectors/cannibalization.ts` (never rebuild) - classification tiers `POSSIBLE_CANNIBALIZATION | INTENT_DISTINCT | NORMAL_URL_DIVERSITY | NEEDS_REVIEW | INSUFFICIENT_DATA`; historical query->page shift over stored `query_page` facts; coverage-integrity per existing semantics (200+empty rows != gap, missing facts = failed sync); recommendations non-destructive (consolidation/canonical review/intent differentiation only)."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Know whether an overlapping query is really a conflict (Priority: P1)

A project owner sees a cannibalization finding and can tell which situation they are
in: two pages competing for the same query (possible cannibalization), two pages that
mostly serve different queries (distinct intent), two URLs where one page clearly
carries the query (normal URL diversity), a recent change in which URLs serve the query
(needs review), or not enough Search Console data to tell (insufficient data). The
verdict is stated with the observed evidence behind it, never as a guess about intent.

**Why this priority**: The detector already reports "potential cannibalization" for any
two-URL overlap. Without a verdict, every overlap looks identical and the owner cannot
decide whether to change anything.

**Independent Test**: Build a fixture with a balanced two-URL overlap, a lopsided
overlap, two pages with disjoint query sets, and a query whose serving URLs changed
between windows. Assert each candidate receives its tier and that the tier is visible
in the finding evidence and opportunity copy.

**Acceptance Scenarios**:

1. **Given** two URLs above the impression floor for the same query with an even
   impression split and overlapping query sets, **When** the detector classifies the
   candidate, **Then** the tier is `POSSIBLE_CANNIBALIZATION`.
2. **Given** two URLs where one accounts for at least the dominant share of the
   query's impressions, **When** the detector classifies the candidate, **Then** the
   tier is `NORMAL_URL_DIVERSITY` and the recommendation asks for confirmation, not
   consolidation.
3. **Given** two URLs whose observed query sets barely overlap, **When** the detector
   classifies the candidate, **Then** the tier is `INTENT_DISTINCT`.
4. **Given** a candidate whose set of serving URLs differs between the current and
   the previous window, **When** the detector classifies the candidate, **Then** the
   tier is `NEEDS_REVIEW` and the observed shift is part of the evidence.
5. **Given** a candidate with no Search Console query-page facts (rank overlap only)
   or without a comparable previous window, **When** the detector classifies the
   candidate, **Then** the tier is `INSUFFICIENT_DATA` and the missing data is named.

### User Story 2 - Trust the coverage behind the verdict (Priority: P1)

The owner can tell when a window is not comparable and why. A window whose sync never
ran is reported as not covered instead of being read as "no overlap". A day that was
synced but produced no rows is never treated as a coverage gap. Row counts never decide
coverage, and the evidence never contains more rows than the documented cap.

**Why this priority**: Missing data silently read as "no problem" is the failure mode
that makes an audit untrustworthy. The repo's existing GSC coverage semantics
(sync intervals first, zero-row days still covered) are the contract.

**Independent Test**: With a failed sync in the ledger, the detector refuses to assert
absence and marks the prior window as not covered. With a completed sync and empty
days, the window stays covered. Evidence row counts stay at or below the cap.

**Acceptance Scenarios**:

1. **Given** no completed or partial sync covers the current window and the stored
   fact days are below the coverage ratio, **When** the detector fetches input,
   **Then** the detector is skipped with an `INSUFFICIENT_COVERAGE` reason.
2. **Given** a completed sync covers the window even though some days have no rows,
   **When** the detector fetches input, **Then** the window is analyzed and the day
   ratio is reported as a metric.
3. **Given** the previous window is not covered by a successful sync, **When** the
   detector classifies a candidate, **Then** no shift is asserted and the missing
   history is named in `partialData`.

### User Story 3 - Act without destructive guesses (Priority: P2)

When a cannibalization opportunity is shown, its guidance stays non-destructive:
consolidation, canonical review, or intent differentiation. The guidance matches the
tier, and nothing in the wording claims a cause.

**Why this priority**: The repo's observational contract forbids causal claims and
destructive prescriptions in this surface.

**Independent Test**: Render each tier's opportunity title and recommendation and
assert the wording matches the tier, contains no causal verb, and prescribes no
deletion, redirect, or removal.

**Acceptance Scenarios**:

1. **Given** a `POSSIBLE_CANNIBALIZATION` finding, **When** the opportunity is
   materialized, **Then** the recommendation offers consolidation, canonical review,
   or intent differentiation.
2. **Given** a `NEEDS_REVIEW` finding, **When** the opportunity is materialized, **Then**
   the recommendation asks the owner to review which URLs serve the query before
   changing anything.
3. **Given** any tier, **When** the opportunity is materialized, **Then** the title and
   recommendation contain no causal verb and no destructive instruction.

### Edge Cases

- Small sites: a query served by two URLs with a handful of impressions is classified
  as insufficient data rather than reported as a conflict.
- Self-referential and duplicate rows: one page's facts are counted once per
  (query, page, date) fact row; URLs are compared after canonical URL normalization.
- A URL that only appears in the previous window is reported as a shift, not as a
  current overlap.
- Rank-overlap witnesses with no Search Console facts are classified as insufficient
  data; they are never presented as a classified conflict.
- Query sets are compared with canonicalized queries, so casing and spacing
  differences do not inflate or deflate the overlap.
- The previous window is compared only when it is covered; an uncovered previous
  window never produces a "no change" claim.
- Evidence is capped; a cap never changes a tier.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST extend the existing `cannibalization` detector; it MUST
  NOT add a parallel detector, a new source, or a new table.
- **FR-002**: Every classified candidate MUST receive exactly one tier:
  `POSSIBLE_CANNIBALIZATION`, `INTENT_DISTINCT`, `NORMAL_URL_DIVERSITY`,
  `NEEDS_REVIEW`, or `INSUFFICIENT_DATA`. The tier MUST be present in the finding
  entity, evidence metrics, and coverage flags.
- **FR-003**: Classification MUST use only observed facts: per-URL impression counts
  for the query, the per-URL observed query sets, the impression split, and the
  previous window's serving URLs.
- **FR-004**: The tier thresholds MUST be injected thresholds
  (`dominantShare`, `intentOverlapMax`, `maxEvidenceRows`) and echoed in the finding
  evidence. Thresholds MUST NOT be hardcoded in the detector.
- **FR-005**: Historical shift MUST be computed from stored `query_page` facts in the
  immediately preceding window of the same length. A shift MUST be reported only when
  that previous window is covered by a successful sync (or its stored fact days reach
  the coverage ratio).
- **FR-006**: Coverage MUST follow the repository's existing GSC semantics: a window
  covered by a completed or partial sync is covered even when a day has no rows; a
  window that was never synced, or whose sync failed, is not covered and MUST NOT be
  read as "no overlap". Row counts MUST NOT decide coverage.
- **FR-007**: When the current window is not covered, the detector MUST be skipped
  with an `INSUFFICIENT_COVERAGE` reason rather than emitting findings from partial
  data.
- **FR-008**: Evidence row counts MUST be capped at the injected `maxEvidenceRows`
  value, and the cap MUST NOT influence classification.
- **FR-009**: Recommendations MUST be produced by the materializer template, never by
  the detector, and MUST match the tier: consolidation/canonical review/intent
  differentiation for possible cannibalization, confirmation for URL diversity, review
  before change for needs review, and re-sync or manual review for insufficient data.
- **FR-010**: Detector prose MUST remain observational: no causal verbs, and no
  claim about intent that was not observed.
- **FR-011**: The opportunity surface MUST show the tier with a human label, and MUST
  keep the tier visible next to the observed metrics.
- **FR-012**: The detector version MUST be bumped so existing opportunities are
  superseded by tier-aware ones, and the threshold version MUST be bumped so the new
  thresholds are applied and recorded.
- **FR-013**: The detector MUST keep its existing emission bar: at least
  `minUrls` URLs above the per-URL impression floor, or a rank-overlap witness with
  at least `minUrls` URLs.

### Non-Functional Requirements

- **NFR-001**: No new paid provider, network read, table, or background job. The
  detector reads the stored `gsc_search_performance` rows it already reads.
- **NFR-002**: Memory and payload stay bounded: per-URL query sets and evidence ids
  are capped, and the candidate set stays proportional to the window's query count.
- **NFR-003**: Classification is deterministic: identical stored facts and thresholds
  produce identical tiers, ordering, and prose.
- **NFR-004**: The change stays inside the existing file and function limits and
  follows the co-located test conventions.

### Key Entities

- **CannibalizationClassification**: one of the five tiers.
- **CannibalizationCandidate**: the query, its URLs, per-URL impressions, impression
  split, observed query-set overlap, previous-window serving URLs, shift flags, and
  coverage flags.
- **Finding (existing)**: detector output; gains a `classification` metric, entity
  value, and coverage flags.

## Success Criteria _(mandatory)_

- **SC-001**: Unit tests cover all five tiers, the shift rule, the coverage rules
  (covered-but-empty vs never-synced vs failed sync), and the emission bar.
- **SC-002**: A fixture with a balanced overlap classifies as
  `POSSIBLE_CANNIBALIZATION`; a lopsided overlap as `NORMAL_URL_DIVERSITY`; disjoint
  query sets as `INTENT_DISTINCT`; a changed URL set as `NEEDS_REVIEW`; a rank-only
  witness as `INSUFFICIENT_DATA`.
- **SC-003**: The detector's prose and the opportunity template contain no causal
  verb, and no tier prescribes deletion, redirect, or removal.
- **SC-004**: The opportunity detail shows the tier with a human label, and the raw
  metric row for the tier is not duplicated.
- **SC-005**: The existing intelligence suites (registry, detection stage, detector
  inputs, boundaries) stay green, `tsc`, Prettier, oxlint, knip, and `pnpm build`
  are green, and the full suite shows no new failures (one pre-existing env-gated
  live-API failure excepted).

## Assumptions

- Phase 5 (spec 017) is merged into the integration baseline; this phase branches
  from that baseline.
- The `cannibalization` detector, its thresholds, its entity key, its template, and
  the `gsc_search_performance` query-page grain all exist and are unchanged in
  behavior apart from this feature.
- GSC sync coverage semantics (`hasCoverage`, sync intervals, zero-row days) are the
  authoritative coverage contract and are reused as-is.
- Rank tracking stays an optional corroborator: its failure never blocks the GSC
  path, and rank-only witnesses carry no impressions.
- The repository's `200`-row evidence cap is expressed as an injected threshold
  (`maxEvidenceRows`) so it is visible in evidence; row counts never decide coverage.
