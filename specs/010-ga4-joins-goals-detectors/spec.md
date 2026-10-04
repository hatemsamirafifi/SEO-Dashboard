# Feature Specification: GA4 Joins, Goals, GA4-Backed Detectors, and Opportunities Depth

**Feature Branch**: `010-ga4-joins-goals-detectors`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "Wave 3 (per docs/speckit-implementation-plan.md §3): package 010 — ga4_project_goals table + CRUD + analytics filtering (never sum non-additive users); organic join service (GA4×GSC×Rank via 006 identity, DB-first, coverage-gated, correlational language only); C2b conversion + C2c engagement detectors; opportunities UI filters (page/keyword/source/type/status/priority) with evidence detail. Needs 002 + 006 (G1, G2). Implements PR4 + PR10 + PR11 (B2b/B2c, C2b/C2c, C3)."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Define GA4 goals and filter analytics by them (Priority: P1)

A project owner connects GA4, then defines named goals for the project (for example "newsletter signups",
"demo requests") so that analytics views and opportunities can talk about conversions in the project's own
language. The owner can create, edit, archive, and list goals, and the Analytics pages can filter
acquisition, landing-page, and event views by a chosen goal. Totals for goal conversions are computed from
per-row conversion numerators and denominators — never by summing non-additive user metrics across periods
or grains (Constitution P23).

**Why this priority**: Goals are the vocabulary every later capability in this package needs: conversion
detectors, join confidence, and opportunity evidence all reference a goal. Without goals the GA4-backed
layer cannot speak the user's language.

**Independent Test**: Can be fully tested by creating a goal, filtering an analytics view by it, and
asserting the filtered numbers match seeded GA4 rows — with zero-row and not-connected states rendered
honestly — without touching joins or detectors.

**Acceptance Scenarios**:

1. **Given** a project with a connected GA4 property, **When** the user creates a goal with a name and its
   defining GA4 event/name mapping, **Then** the goal is persisted project-scoped, appears in the goal
   list, and can be edited and archived without losing historical references.
2. **Given** analytics views over stored GA4 data, **When** the user filters by a goal, **Then** conversion
   figures are derived from stored per-grain conversion numerators/denominators for that goal — never by
   summing distinct users across grains or periods.
3. **Given** a project with no GA4 connection or a successful sync that returned zero rows, **When** the
   user opens the goals or filtered analytics views, **Then** the state renders as not-connected or
   no-data respectively — never as zero conversions that look like a measured fact (Constitution P9, P21).

---

### User Story 2 - See page-level organic performance joined across GA4, GSC, and Rank Tracking (Priority: P2)

An SEO analyst opens a page-level organic view and sees, per canonical page, GA4 engagement and conversion
signals next to GSC clicks/impressions and tracked rank positions. The join is deterministic: every source
row is matched through the single canonical URL identity shipped by 006 (no per-feature canonicalizers),
built database-first from stored grains, and gated by coverage — pages without GA4 data are marked
GA4-unavailable rather than joined as zeros, and the view uses correlational language ("appears with",
"alongside") — never causal claims (Constitution P24, P46, G1).

**Why this priority**: The joined page view is the analytical heart of Track B/C integration — it turns
three siloed stores into one decision surface and is the input contract the C2b/C2c detectors build on.

**Independent Test**: Can be fully tested by seeding GA4, GSC, and rank rows for overlapping and
non-overlapping canonical pages, running the join service, and asserting per-page rows, coverage marks,
and zero fabricated matches — with detector registration disabled or ignored.

**Acceptance Scenarios**:

1. **Given** stored GA4, GSC, and rank-tracking grains whose canonical URLs (per the 006 identity) match,
   **When** the organic join runs, **Then** one row per canonical page carries each source's metrics with
   source provenance, and no cross-source metric is invented for sources that have no data for that page.
2. **Given** a page present in GSC but absent from GA4 (or with failed GA4 coverage), **When** the join
   runs, **Then** the row is marked GA4-unavailable/coverage-capped rather than zero-filled, and any
   downstream confidence accounts for the missing source.
3. **Given** join outputs shown to users, **When** wording is rendered, **Then** descriptions are
   correlational only — no causal phrasing — and each metric keeps its source classification
   (first-party vs provider) per Constitution P47.

---

### User Story 3 - Get GA4-backed conversion and engagement opportunities (Priority: P3)

After an intelligence scan, the manager finds new GA4-backed opportunities: project goals whose GA4
conversions dropped materially (conversion detector, C2b — one opportunity per goal, site-level, since
stored event grains carry no page dimension) and pages whose engagement collapsed while ranking held
(engagement detector, C2c — per page). Both detectors register in the existing detector registry with stable
finding keys, respect coverage gating (no trigger on absent GA4, failed sync, or insufficient
impressions), and materialize through the existing opportunity templates with separate impact and
confidence scores — no second engine, no new scoring model (G2, G3, Constitution P25, P26, P28).

**Why this priority**: The detectors convert the joins + goals foundation into prioritized action — the
actual Track C deliverable of this package.

**Independent Test**: Can be fully tested by seeding before/after GA4 grains (with goals defined) and
GSC/rank coverage, running the registry scan, and asserting exactly the expected opportunities with
frozen evidence — independent of the UI-depth story.

**Acceptance Scenarios**:

1. **Given** two comparison windows of stored GA4 data where a project goal's conversion count
   drops beyond the detector threshold with adequate coverage, **When** the scan runs, **Then**
   exactly one conversion-drop opportunity is emitted for that goal, with frozen evidence naming
   the goal (frozen name snapshot), both windows, and the delta.
2. **Given** a project where GA4 is not connected, the sync failed, or coverage is insufficient,
   **When** the scan runs, **Then** neither GA4-backed detector triggers and the skip is recorded with a
   reason (G9, Constitution P28).
3. **Given** re-running the scan over the same windows, **When** results materialize, **Then** no
   duplicate opportunities or ledger events are created (idempotent emission), and impact/confidence are
   reported as separate scores.

---

### User Story 4 - Triage opportunities with richer filters and evidence detail (Priority: P4)

The manager works the Opportunities list with real triage filters — page, keyword, source, type, status,
and priority — and can open any opportunity to inspect its frozen evidence detail (the underlying facts,
source snapshots, and window comparisons) without leaving the workflow. Filters compose and degrade
honestly: filtering to a combination with no matches shows an explicit empty state, never a zero-looking
dashboard.

**Why this priority**: The C3 deliverable makes the growing opportunity volume (waves 1–3 add several new
types) workable; without it, the new detectors create noise users cannot navigate.

**Independent Test**: Can be fully tested by seeding opportunities of multiple types/pages/sources and
asserting filter composition and evidence-detail rendering over existing surfaces — no detector or join
changes required.

**Acceptance Scenarios**:

1. **Given** a project with opportunities of multiple types, sources, pages, and statuses, **When** the
   user applies page + type + status filters together, **Then** only matching opportunities are listed,
   counts reflect the filtered set, and a no-match combination renders an explicit empty state.
2. **Given** any opportunity in the list, **When** the user opens its detail, **Then** the frozen
   evidence renders with its recorded facts and provenance, identical to what was stored at emission —
   not recomputed.
3. **Given** the filter toolbar, **When** a filter dimension has no available values (for example no
   keywords on any current opportunity), **Then** that filter presents honestly (disabled or
   not-applicable) rather than pretending an empty set is a real filter choice.

### Edge Cases

- What happens when a goal's underlying GA4 event stops existing or is renamed in GA4? The goal remains
  historical, its analytics show no-data for periods where the mapping yields nothing, and editing the
  mapping is explicit — never silently remapped.
- What happens when the same canonical page appears under multiple raw URL variants across sources? The
  006 identity collapses them to one row; no variant is preferred by insertion order — matching is
  deterministic.
- What happens when GA4 sync is mid-run or stale while GSC is fresh? Coverage gating marks GA4 as
  partial/stale for the join; detectors use the capped-confidence path, never silently trusting stale
  grains.
- What happens when comparison windows contain different numbers of days? Window comparison normalizes
  per existing detector conventions (per-day or equivalent normalization) so longer windows do not
  fabricate larger deltas.
- What happens on very large projects with thousands of canonical pages? The join stays database-first
  and bounded (batched reads, no unbounded in-memory cross-source loops), preserving project isolation.
- What happens when an opportunity type is filtered out by source (for example GA4-backed types with GA4
  disconnected)? Those types are simply absent from results — never fabricated as zero-severity entries.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST provide project-scoped GA4 goals (create, edit, archive, list) with strict
  input validation and project/organization access checks on every operation (Constitution P39).
- **FR-002**: Analytics views MUST support goal-based filtering where stored GA4 data supports it, and
  MUST derive conversion aggregates from per-grain numerators/denominators — summing distinct users
  across grains or periods MUST NOT occur (Constitution P23).
- **FR-003**: Goal CRUD and analytics filtering MUST preserve honest states: not-connected, no-data
  (successful zero rows), partial, and failed MUST each render distinctly and never as zero-valued
  facts (Constitution P9, P21, P30).
- **FR-004**: The system MUST expose an organic join capability that correlates GA4, GSC, and
  rank-tracking stored grains per canonical page using exclusively the 006 canonical URL identity
  helper — no feature-local canonicalization (Constitution P24, G1).
- **FR-005**: The organic join MUST be database-first, bounded, project-scoped, and coverage-gated:
  sources missing for a page (absent, stale, partial, or failed) MUST be marked unavailable and MUST
  NOT be zero-filled; a documented import-ban/boundary test MUST prevent parallel canonicalizers or
  joins.
- **FR-006**: Join-derived views MUST use correlational language only and MUST carry source
  provenance/data classification per metric (Constitution P46, P47).
- **FR-007**: The system MUST add two GA4-backed detectors to the existing registry — conversion drop
  (C2b, per active goal, site-level — stored event grains carry no page dimension, research R5) and
  engagement drop (C2c, per canonical page) — each with stable finding keys, versioned thresholds,
  and coverage gating; they MUST NOT trigger on absent GA4, failed syncs, or insufficient coverage,
  and skips MUST be recorded with reasons (G2, G9, Constitution P28).
- **FR-008**: Both detectors MUST materialize through the existing opportunity pipeline with separate
  impact and confidence scores, frozen evidence, and idempotent emission over identical scan inputs
  (Constitution P26, P27, G3).
- **FR-009**: The Opportunities UI MUST support composable filters by page, keyword, source, type,
  status, and priority over existing stored opportunity data, with explicit empty states and honest
  handling of value-less filter dimensions.
- **FR-010**: The Opportunities UI MUST expose evidence detail for any opportunity, rendering the
  frozen stored evidence and provenance without recomputation (Constitution P27, P31).
- **FR-011**: Schema changes (the goals table) MUST be additive with D1/Postgres parity, project-scoped
  foreign keys, and parity/migration tests extended in the same change (Constitution P3–P5).
- **FR-012**: New analytics-reading surface MUST NOT trigger paid provider calls on render; all data
  comes from stored grains (G10, Constitution P29).
- **FR-013**: Major new operations (goal changes, organic join execution, detector scans) MUST emit
  appropriate trace entries without secrets, while durable ledgers remain authoritative
  (Constitution P41, P42).

### Key Entities

- **Ga4ProjectGoal**: A named, project-scoped conversion goal defined over GA4 events; attributes
  include display name, GA4 event/name mapping, and lifecycle state (active/archived); historical
  analytics remain interpretable after archive.
- **OrganicPageJoin**: One correlated per-page record joining GA4 engagement/conversion grains, GSC
  performance grains, and rank-tracking positions through canonical URL identity, carrying per-source
  metrics, per-source coverage state, and provenance.
- **ConversionDropFinding / EngagementDropFinding**: Detector outputs in the existing finding model:
  stable keys, threshold-driven, evidence-frozen, coverage-gated.
- **OpportunityFilterState**: The composable filter state (page, keyword, source, type, status,
  priority) applied over stored opportunities for the list surface.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can create a goal, filter analytics by it, and see conversion figures that match
  seeded GA4 rows exactly, with zero-user-summing violations reproducible by test (any aggregate that
  would sum distinct users fails the suite).
- **SC-002**: For seeded overlapping and non-overlapping page sets across the three sources, the join
  returns one row per canonical page with 100% of available source metrics and zero invented metrics;
  every unavailable source is explicitly marked, and 100% of user-facing join wording is
  correlational.
- **SC-003**: Across all seeded GA4-absent/failure/insufficient-coverage scenarios, the two new
  detectors emit zero opportunities and record a skip reason for every evaluation; with valid seeded
  windows they emit exactly one opportunity each with frozen evidence and separate impact/confidence
  scores.
- **SC-004**: Re-running scans over identical windows produces zero duplicate opportunities and zero
  duplicate ledger events across at least two re-runs.
- **SC-005**: An analyst can compose any two Opportunities filters and get a correct result set within
  normal interactive time, with explicit empty states for no-match combinations; evidence detail
  renders frozen stored evidence for every opportunity type in the project.
- **SC-006**: All required gates pass: schema parity green for the new table, typecheck and lint pass,
  and the boundary/import tests prove single canonicalizer and single engine usage.

## Assumptions

- Specs 002 (GA4 geo/tech grains and sync semantics) and 006 (canonical URL identity) are complete and
  merged; their contracts are mandatory inputs here (G1, G2 satisfied upstream).
- Goals map to GA4 event-scoped conversions already captured in stored GA4 grains (existing
  acquisition/landing-page/event tables); no new GA4 API dimensions are fetched by this feature.
- Detector thresholds follow the existing versioned-threshold conventions in the shared threshold
  module; defaults are tunable per project where the configuration model supports it.
- The organic join reuses the existing AnalyticsJoinService extension points rather than creating a
  second join system (Constitution P2); any contradiction discovered with the live repository is
  surfaced, not silently resolved (P48–P49).
- Opportunities filtering operates over stored opportunity fields and existing index patterns; a
  keyword dimension exists via existing opportunity evidence linkages — if repository discovery
  shows keyword linkage absent for some types, those types present the dimension honestly as
  not-applicable rather than fabricating values.
- UI work extends existing Opportunities list/detail surfaces; no redesign beyond the filter toolbar
  and evidence-detail presentation.
- MCP exposure of new analytics tools (get_analytics_acquisition/events/conversions) is folded into
  this package as thin service wrappers only, per the implementation plan §4 cross-cutting note.
- E2E coverage is added where the feature crosses major boundaries (goal CRUD → analytics filter →
  opportunity triage), per Constitution P44.
