# Feature Specification: Dashboard Stored Rollups

**Feature Branch**: `001-dashboard-stored-rollups`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Extend DashboardService.getOverview to aggregate stored intelligence data (GSC, GA4, Rank Tracking, Opportunities, Insights, Audit, Backlinks) with current-vs-previous equivalent period windows. Dashboard remains read-only over stored/normalized data — no render-time provider calls. Output groups: SEO Performance, Search Visibility, Traffic & Engagement, Conversions, Opportunities, Technical Health, Backlinks, Recent Changes. Implements Track A milestone A0 of the Final Revised Implementation Plan (PR1)."

## Clarifications

### Session 2026-09-28

- Q: How is the "previous period" defined for dashboard deltas? → A: Immediately-preceding window of equal day length (e.g., last 28 days vs the 28 days before), day-aligned, reusing the same resolved date-boundary logic across GSC, GA4, rank, and dashboard rollups. Missing/insufficient prior coverage yields an unavailable/null delta — never 0%, +100%, or -100% — with partial coverage surfaced explicitly.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - View stored intelligence overview with period deltas (Priority: P1)

A site owner opens the project dashboard and sees an intelligence overview: SEO Performance (clicks,
impressions, CTR, average position), Search Visibility (Top 3 / Top 10 / Top 100, improved, declined),
and Traffic & Engagement (sessions, organic sessions, engaged sessions, engagement rate) — each with a
current-vs-equivalent-previous-period delta. All numbers come from already-stored data; opening the
dashboard never triggers a paid data fetch.

**Why this priority**: This is the core A0 value — turning the dashboard from onboarding cards into an
intelligence surface. Every other dashboard section builds on these read contracts.

**Independent Test**: Can be fully tested by connecting GSC/GA4, running a sync, opening the dashboard,
and verifying each of the three sections renders stored values plus deltas without any new provider call.

**Acceptance Scenarios**:

1. **Given** a project with completed GSC and GA4 syncs, **When** the owner opens the dashboard,
   **Then** SEO Performance, Search Visibility, and Traffic & Engagement show current values with
   previous-period deltas and source/coverage labels.
2. **Given** a project with no GA4 connection, **When** the owner opens the dashboard,
   **Then** Traffic & Engagement shows a "not connected" state instead of zeros or blank cards.
3. **Given** a failed GSC sync, **When** the owner opens the dashboard,
   **Then** SEO Performance shows an "unavailable / sync failed" state — never `0` clicks/impressions.

---

### User Story 2 - See conversions, opportunities, health, and backlinks at a glance (Priority: P2)

The owner also sees Conversions (configured key events, transactions when available, explicit
"not configured" otherwise), Opportunities (Critical / High / Medium counts linking to the Opportunities
page), Technical Health (latest audit health, important-page issues, stale/no-audit states), and Backlinks
(totals, referring domains, new/lost changes).

**Why this priority**: Completes the eight output groups; each is independently valuable but none blocks
the P1 overview.

**Independent Test**: Can be tested per section by setting up the corresponding source (goals, opportunities,
audit, backlink snapshot) and verifying the section reflects stored state including empty/unavailable variants.

**Acceptance Scenarios**:

1. **Given** a project with open opportunities, **When** the owner opens the dashboard,
   **Then** the Opportunities section shows Critical / High / Medium counts that link to the Opportunities page.
2. **Given** a project with no configured conversion goals, **When** the owner views Conversions,
   **Then** the section states goals are not configured instead of reporting zero conversions.
3. **Given** a project whose latest audit is stale or missing, **When** the owner views Technical Health,
   **Then** the section shows the stale/no-audit state with the last successful audit date.

---

### User Story 3 - Review recent changes as facts vs recommendations (Priority: P3)

The owner sees a Recent Changes feed of stored insights that visually distinguishes observed facts
("what happened") from recommendations ("what to do"), with per-item source badges and detection time.

**Why this priority**: Delivers the insight-feed half of A0; depends on stored insights existing but is
independently testable with fixture insights.

**Independent Test**: Can be tested by seeding stored insights and verifying the feed renders fact vs
recommendation blocks with source badges.

**Acceptance Scenarios**:

1. **Given** stored insights exist, **When** the owner opens Recent Changes,
   **Then** each item shows its fact, its recommendation (if any) in a distinct block, its source badge,
   and when it was detected.

---

### Edge Cases

- What happens when a source has partial coverage for the window (some days synced, some failed)?
  The section renders a "partial" state with the coverage note; partial data never silently renders as complete.
- How does the overview handle a project with zero connected sources? All sections show "not connected"
  guidance, never zeros.
- What happens when the previous period has no data (new project)? Deltas show an unavailable state with
  a "no prior data" note instead of misleading percentage swings (never 0%, +100%, or -100%).
- How are currency-mixed or unit-mixed values handled? Each metric renders with its unit; no cross-unit sums.
- What happens on equivalent-period comparison across a daylight-saving or short-month boundary? Windows are
  day-aligned with equal length; the window definition is documented in the read contract.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The dashboard overview MUST aggregate only stored/normalized data (GSC, GA4, Rank Tracking,
  Opportunities, Insights, Audit, Backlinks). Rendering the dashboard MUST NOT invoke any paid provider API.
- **FR-002**: Every metric section MUST show the current window alongside the immediately-preceding window
  of equal day length (day-aligned; e.g., last 28 days vs the 28 days before), plus the change between them.
  All sources (GSC, GA4, rank, dashboard rollups) MUST reuse the same resolved date-boundary logic.
  Missing or insufficient prior-period coverage MUST yield an unavailable/null delta — never 0%, +100%,
  or -100% — with partial coverage surfaced explicitly.
- **FR-003**: Every section MUST expose source and coverage metadata (which source, how fresh, full or partial).
- **FR-004**: A failed or missing source MUST render as an explicit unavailable/not-connected/sync-failed state.
  It MUST NEVER render as `0`, "no traffic", "no rankings", or "no opportunities".
- **FR-005**: All reads MUST be scoped to the requesting project; a wrong-project request MUST be rejected.
- **FR-006**: The overview MUST cover all eight output groups: SEO Performance, Search Visibility,
  Traffic & Engagement, Conversions, Opportunities, Technical Health, Backlinks, Recent Changes.
- **FR-007**: The read contracts defined here (method shapes, section payloads, state model) MUST remain stable
  for the Dashboard Intelligence Sections package (A1 UI) to build on without rework.
- **FR-008**: Search Visibility MUST distinguish ranking bands (Top 3 / Top 10 / Top 100) and movement
  (improved / declined), with unavailable/failed counts surfaced where the underlying data is incomplete.

### Key Entities

- **DashboardOverview**: The per-project aggregated view; attributes include the eight section payloads,
  window definitions (current + previous), and per-section source/coverage metadata.
- **SectionState**: The display state of one section — loading, ready, empty, not_connected, no_data, partial,
  stale, api_failed, permission_failed, sync_running, sync_failed. Failure states never coerce to zero.
- **PeriodDelta**: A current value, previous-window value, and their change; carries a "no prior data" variant.
- **CoverageNote**: Source identity, freshness, and completeness (full/partial) attached to each section.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A project owner with synced sources sees all eight output groups on the dashboard, each with
  current values, previous-period comparison, and a source/coverage label.
- **SC-002**: Disconnecting or breaking any single source changes only its section(s) to an explicit
  unavailable state; no section anywhere on the dashboard displays `0` for a failed source.
- **SC-003**: Opening the dashboard performs zero paid provider calls (verifiable via the existing
  cost/trace diagnostics showing no paid activity for the view).
- **SC-004**: A brand-new project with no connected sources sees guidance states in every section within
  the normal dashboard load time, with no error banners caused by missing data.

## Assumptions

- GA4 device/country breakdown filters are NOT part of this feature; they arrive with the GA4 geo/tech
  grains package (002). Sections depending on those grains show capability-gated states until then.
- The full 11-state unified section-state model (A2) is finalized in a later package; this feature defines
  the read contracts and uses the same state vocabulary so the later model is a rename-free adoption.
- Existing previous-period helpers and stored sync coverage ledgers are reused as-is.
- The visual rebuild of dashboard cards (A1) is a separate package; this feature is the data/contract layer.
