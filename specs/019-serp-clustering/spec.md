# Feature Specification: SERP Clustering and Organic Snapshot Storage

**Feature Branch**: `feat/p1-serp-clustering`
**Created**: 2026-10-24
**Status**: Implemented - Phase 7 delivered 2026-10-24: the organic results the rank check already paid for are stored in a new dual-dialect `serp_organic_snapshots` table (migrations 0070/0048) with a project/market/device index, a freshness index, and a run-scoped unique constraint; the write runs inside the live and queued rank-check paths with full failure isolation; a clustering service groups pages that keep appearing together on at least three tracked keywords (bridge-guarded, market/device/engine compatible) and reports honest coverage states; new-page clusters are emitted as opportunities through the existing detector path; and the rank-tracking detail view shows the clusters with the forward-looking caveat. Unit suites, `tsc`, oxlint, and knip show no new findings; the full suite has one pre-existing env-gated live-API failure; `pnpm build` is green (see `docs/plans/reports/2026-10-24-serp-clustering-phase7-verification.md`).
**Input**: User description: "Phase 7 of the P1 SEO Intelligence master plan (`docs/plans/2026-10-17-p1-seo-intelligence-implementation.md` section 3.2 row 7): `serp_organic_snapshots` table (dual dialect; project/market/device/freshness indexes); writer inside rank-check path with failure isolation; parity migration tests; clustering service (threshold=3, bridge guards, engine/location/language/device/freshness compatibility); coverage states + %; opportunity emission for new-page clusters; forward-looking caveat in UI. Section 1 (line ~85) additionally requires: extend the rank-tracking SERP pipeline to persist the top-10 organic URLs already returned by successful provider calls - no new paid SERP requests."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Keep the organic result set of every rank check (Priority: P1)

When a rank check runs, the organic results the provider already returned are stored
alongside the tracked keyword: position, title, URL, normalized URL, market, device,
engine, provider, the rank-check run, and when it was observed. A failure to store
them is reported on its own and never breaks the rank check or the rank snapshot.

**Why this priority**: The organic set is already paid for by the existing rank
check. Storing it costs no new provider calls and is the only input the clustering
service needs.

**Independent Test**: Run a rank check against a stubbed provider that returns a
target match plus other organic results; assert the organic rows are written with
their market and device, and that a failing write leaves the rank snapshot intact
and reports its own error.

**Acceptance Scenarios**:

1. **Given** a successful provider call that returns organic results,
   **When** the rank check persists its snapshots, **Then** the top-10 organic
   results are stored for that keyword, device, market, engine, and run.
2. **Given** the organic write fails, **When** the rank check finishes, **Then** the
   rank snapshot and the run status are unchanged and the failure is reported
   independently.
3. **Given** a provider call that fails, **When** the rank check runs, **Then** no
   organic rows are written and the provider failure semantics (including the
   permanent `40201` behaviour) are unchanged.

### User Story 2 - See which pages keep ranking together (Priority: P1)

A project owner opens the rank-tracking view and sees the page clusters observed
for their market and device: which pages repeatedly appear together across
keywords, how many keywords each cluster covers, and whether the cluster contains a
page the project does not own yet. The view states how much of the tracked keyword
set has usable organic data, and labels the analysis as forward-looking.

**Why this priority**: Pages that keep appearing together are a topical cluster in
the observed SERP; when one of them is missing from the project, that is a concrete,
evidence-backed content opportunity.

**Independent Test**: Seed organic snapshots for three keywords where two pages
co-occur, assert one cluster with the co-occurrence count, assert a page that
appears on only one keyword is not clustered, and assert a cluster whose pages all
belong to the project is not offered as a new-page opportunity.

**Acceptance Scenarios**:

1. **Given** pages that co-occur on at least three tracked keywords in the same
   market and device, **When** the clustering service runs, **Then** one cluster
   lists those pages with the observed keyword count.
2. **Given** a page that bridges two otherwise separate groups, **When** the
   clusters are built, **Then** the groups stay separate.
3. **Given** snapshots from a different market, device, or engine, **When** the
   clusters are built, **Then** they are not mixed with the current market's
   results.
4. **Given** a cluster that contains a page the project does not own, **When** the
   opportunity is emitted, **Then** it names the pages, the keywords, and the
   observed positions.

### User Story 3 - Act without over-claiming (Priority: P2)

The cluster view and the emitted opportunity state that the analysis is
forward-looking: it reflects the organic results observed so far, not a forecast,
and it is a heuristic, not a ranking verdict.

**Why this priority**: The repo's contract for this surface forbids causal claims
and unearned certainty.

**Independent Scenarios**:

1. **Given** a cluster, **When** the view renders, **Then** it carries the
   forward-looking caveat and never promises a ranking outcome.
2. **Given** an emitted opportunity, **When** it is materialized, **Then** its
   guidance is a review suggestion and contains no causal verb.

### Edge Cases

- Small keyword sets: fewer than the clustering threshold of three co-occurring
  keywords produces no cluster; the coverage state still reports what was observed.
- A page that ranks for one keyword only is never clustered.
- Same page with different URL variants (trailing slash, query string) is
  compared by its normalized URL.
- The same run replayed (workflow step restart) does not duplicate organic rows.
- A market with no organic data yet reports "awaiting data", never "no clusters".
- Stale data (older than the freshness window) is excluded from the clusters and
  reported as stale coverage.
- A provider that returns fewer than ten organic results stores what it returned;
  the completeness status records that the set was partial.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST store the organic results already returned by
  successful rank-check provider calls in a new `serp_organic_snapshots` table,
  with no new paid SERP requests.
- **FR-002**: The table MUST exist in both dialects with the same columns, and
  MUST carry the keyword, engine, location, language, device, position, result
  URL, normalized URL, title, domain, provider, the rank-check run id, the
  observed timestamp, and a completeness status.
- **FR-003**: The table MUST have a project/market/device index and a freshness
  index, and both dialects MUST agree on the unique constraint that prevents
  duplicate rows for the same run, keyword, device, and position.
- **FR-004**: The write MUST run inside the rank-check path and MUST be isolated:
  a failed organic write MUST NOT fail the rank check, change the rank snapshot,
  or alter the provider failure semantics.
- **FR-005**: The clustering service MUST group snapshots by engine, location,
  language, and device, and MUST consider only snapshots inside the freshness
  window.
- **FR-006**: A cluster MUST contain pages that co-occur on at least three
  tracked keywords (the threshold is an injected value). A page that bridges two
  groups MUST NOT merge them.
- **FR-007**: The clustering service MUST report a coverage state
  (`ready`, `awaiting_data`, `insufficient_data`, `stale_data`) and the share of
  tracked keywords with usable organic data.
- **FR-008**: A cluster that contains a page the project does not own MUST be
  emitted as an opportunity through the existing detector -> materializer path,
  with deterministic identity and no new workflow or opportunity engine.
- **FR-009**: The cluster view MUST display the coverage state, the coverage
  percentage, the clustered pages with their observed keyword counts, and the
  forward-looking caveat.
- **FR-010**: The clustering thresholds MUST be injected thresholds and echoed in
  the finding evidence.
- **FR-011**: Prose MUST remain observational: no causal verbs, and no claim that
  a cluster produces a ranking outcome.
- **FR-012**: The change MUST NOT alter the existing rank-check invariants: the
  `40201` permanent-failure semantics, provider call accounting, snapshot
  uniqueness, and cancellation.

### Non-Functional Requirements

- **NFR-001**: No new paid provider and no new provider call: the organic rows
  come from responses the rank check already bought.
- **NFR-002**: Bounded work: at most ten organic rows per keyword and device per
  run, bounded clustering input, and no unbounded edge loads.
- **NFR-003**: Deterministic: identical stored rows and thresholds produce
  identical clusters, coverage, and opportunity identity.
- **NFR-004**: Dual-dialect parity is asserted by the schema parity test, and the
  new table's index sets are asserted explicitly.

### Key Entities

- **SerpOrganicSnapshot**: one observed organic result for one keyword, device,
  market, engine, and rank-check run.
- **SerpCluster**: a set of pages that co-occur across tracked keywords, with
  the observed keyword count and the pages' positions.
- **SerpClusterCoverage**: the coverage state and the share of tracked keywords
  with usable organic data.
- **Finding (existing)**: a new detector key emits the cluster as an
  evidence-backed finding.

## Success Criteria _(mandatory)_

- **SC-001**: A rank check stores the organic results it received, with market,
  device, engine, run id, and completeness; a failing write leaves the rank
  check untouched and reports itself.
- **SC-002**: Clustering produces one cluster for pages co-occurring on three or
  more keywords, keeps bridged groups apart, and never mixes markets, devices, or
  engines.
- **SC-003**: The coverage state and percentage are reported honestly, including
  "awaiting data" when nothing was stored yet.
- **SC-004**: A new-page cluster is emitted as an opportunity and shows up in the
  technical SEO ranking with its evidence.
- **SC-005**: The view and the opportunity copy carry the forward-looking caveat
  and no causal verb.
- **SC-006**: Unit suites, schema parity, `tsc`, Prettier, oxlint, knip, the full
  Vitest suite, and `pnpm build` are green (one known env-gated live-API failure
  excepted).

## Assumptions

- The rank-check path is the only writer of organic data; the clustering service
  reads stored rows and never calls a provider.
- The tracked domain identifies the project's own pages; a cluster member on
  another domain is a "new page" candidate.
- Freshness, threshold, and coverage ratios are injected thresholds.
- The existing `SerpOrganicResult` shape (position, title, url, domain) is reused
  as the capture contract; raw provider types stay inside the SERP feature.
- The technical SEO autopilot consumes the new issue type through the existing
  stored issue counts; no new workflow is introduced.
