# Feature Specification: GA4 Geo and Technology Grains

**Feature Branch**: `002-ga4-geo-tech-grains`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Add stored GA4 geo (country) and technology (device/browser/OS) daily grains with deterministic upsert keys, project/date indexes, bounded cardinality, quota-aware sync, and capability-gated empty states. After shipping, device/country analytics filters operate on stored data. Implements Track B milestone B1 of the Final Revised Implementation Plan (PR2). Existing GA4 summary/acquisition/landing/events grains and sync resilience patterns are reused, not rebuilt."

## Clarifications

### Session 2026-09-28

- Q: How does the sync handle dimension values beyond the per-grain cardinality bound? → A: Roll the tail into a deterministic "(other)" row per grain with truncation metadata (isTruncated flag, retained/omitted counts, other-row presence). Aggregate totals are preserved exactly; tail values are never silently dropped. "(other)" means aggregated long-tail values — not missing data, not zero traffic. If GA4 provides no reliable omitted count, retain only the truncation flag plus the "(other)" aggregate — never fabricate the count.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Break down traffic by country from stored data (Priority: P1)

An analyst opens the Analytics page, picks a date range, and breaks sessions and engagement down by
country. The breakdown comes from stored daily geo grains; countries with no recorded sessions in the
window simply don't appear, and a property with no geo coverage shows an explicit empty state.

**Why this priority**: Country breakdown is the highest-demand GA4 slice for SEO (market performance);
it unblocks real device/country filters.

**Independent Test**: Can be fully tested by syncing a GA4 property, opening the country breakdown for a
synced window, and verifying per-country sessions/engagement match the stored grain totals.

**Acceptance Scenarios**:

1. **Given** a synced GA4 property, **When** the analyst views the country breakdown for a synced window,
   **Then** per-country sessions, engaged sessions, engagement duration, page views, event counts, and new
   users are shown from stored data with a coverage label.
2. **Given** a window with no geo coverage, **When** the analyst views the breakdown,
   **Then** an explicit "no data for this period" state appears instead of zeros.

---

### User Story 2 - Break down traffic by device, browser, and OS (Priority: P2)

The analyst slices the same metrics by device category, browser, and operating system to spot
mobile-vs-desktop engagement gaps.

**Why this priority**: Technology breakdowns drive page-experience prioritization; independent of geo.

**Independent Test**: Can be tested by viewing the technology breakdown for a synced window and verifying
device/browser/OS rows with stored metric values.

**Acceptance Scenarios**:

1. **Given** a synced GA4 property, **When** the analyst views the device breakdown,
   **Then** per-device sessions and engagement metrics render from stored data.
2. **Given** a browser value the property never reported, **When** the analyst filters to it,
   **Then** the view shows "no data" rather than zero-filled rows.

---

### User Story 3 - Survive quota exhaustion and partial syncs honestly (Priority: P3)

When the GA4 API quota is exhausted mid-sync or a chunk fails, the affected datesGrains show explicit
quota-failed/partial states; successfully synced dates remain usable and failed dates are never
presented as zero-traffic days.

**Why this priority**: Data honesty under failure is a constitutional invariant; it must ship with the
grains, not after.

**Independent Test**: Can be tested by simulating a quota failure mid-sync and verifying coverage states
per date/grain and the absence of zero-filled failed dates.

**Acceptance Scenarios**:

1. **Given** quota exhaustion stops a sync partway, **When** the analyst views the affected window,
   **Then** synced dates show data, unsynced dates show a quota-failed state, and no failed date
   reports zero sessions.
2. **Given** a retry after quota reset, **When** the sync resumes, **Then** previously failed dates
   backfill without duplicating already-stored rows.

---

### Edge Cases

- What happens when a property reports an explosion of distinct countries/browsers (cardinality spike)?
  Values beyond the bound roll into a deterministic "(other)" row with truncation metadata; aggregates stay
  exact and the UI can distinguish complete from truncated coverage.
- How are "(not set)" / missing dimensions stored? As an explicit sentinel value so missing dimensions
  are distinguishable from failures and behave identically on both supported database backends.
- What happens when the same date/grain syncs twice (retry, overlapping runs)? Deterministic identity
  makes the second write an idempotent upsert — no duplicate rows.
- How do new-user counts aggregate? Only across non-overlapping daily summary rows with a footnote;
  dimensioned new-user values are never summed into project totals.
- What happens on the very first sync of a large property? A bounded initial backfill window applies;
  older history remains explicitly uncovered rather than half-synced.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST store a daily per-country grain (sessions, engaged sessions, engagement
  duration, page views, event counts, new users) keyed deterministically by project, property, date, country.
- **FR-002**: The system MUST store a daily technology grain (same metrics) keyed deterministically by
  project, property, date, device, browser, and OS.
- **FR-003**: Both grains MUST be queryable by project and date range with response times suitable for
  interactive analytics filtering over standard reporting windows.
- **FR-004**: Ingestion MUST be bounded in cardinality: values beyond the per-grain bound roll into a
  deterministic "(other)" row per grain so aggregate totals stay exact and tail values are never silently
  dropped. Truncation metadata MUST record at least the truncation flag and "(other)"-row presence
  (plus retained/omitted counts only when reliably known — never fabricated), letting downstream layers
  distinguish complete from bounded/truncated coverage. "(other)" means aggregated long-tail values,
  not missing data and not zero traffic.
- **FR-005**: Sync MUST be quota-aware: quota exhaustion halts new work, marks affected coverage as
  quota-failed, preserves already-synced data, and resumes cleanly on retry without duplicates.
- **FR-006**: A successful API response with zero rows MUST be stored as an explicit zero-row success,
  distinguishable from API failure. Failed dates MUST NEVER be presented as zero-traffic days.
- **FR-007**: Analytics device/country filters MUST read these stored grains (no live API reads at render).
  Before coverage exists, filters MUST show capability-gated empty states.
- **FR-008**: Grain behavior (identity, null handling, aggregation rules) MUST be identical regardless of
  which supported database backend the deployment uses.

### Key Entities

- **GeoGrain**: Daily per-country metrics for one property; attributes include date, country, the six
  stored metrics, and truncation metadata.
- **TechnologyGrain**: Daily per device/browser/OS metrics for one property; same metric set and metadata.
- **SyncCoverage**: Per date/grain sync state (pending, success with data, success with zero rows, failed)
  with error class and truncation info; the single source of truth for zero-vs-failure.
- **CapabilityFlag**: Per-property flags (e.g., geo/tech available) driving gated empty states in the UI.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Analysts can break sessions and engagement down by country and by device/browser/OS for any
  fully synced window, with values matching the underlying stored grains.
- **SC-002**: After a simulated quota failure mid-sync, every affected date shows an explicit failed state,
  zero failed dates report zero traffic, and a retry backfills them with no duplicate rows.
- **SC-003**: Analytics device and country filters operate entirely on stored data with no live API calls
  during filtering.
- **SC-004**: A property with 10x the normal dimension cardinality still syncs within its scheduled window
  with truncation explicitly recorded and surfaced.

## Assumptions

- The existing GA4 connection/OAuth, client, coverage state machine, and 6-hour sync cadence are reused
  as-is; this feature adds grains, not sync architecture.
- Metric taxonomy follows the established binding rules: additive components stored, ratios derived at
  query; distinct-user metrics never summed; engagement-time metric labeled by its denominator.
- Geo grain dimensions are project, property, date, country; technology grain adds device, browser, OS.
  Finer grains (city, screen resolution) are out of scope.
- Initial backfill window and top-N bounds are set during planning with live-calibration notes; the spec
  fixes the mechanism (bounded + surfaced), planning fixes the numbers.
