# Feature Specification: SERP Features Normalization + Dashboard Intelligence UI

**Feature Branch**: `011-serp-features-ui`

**Created**: 2026-10-02

**Status**: Draft

**Input**: User description: "Wave 3 (per docs/speckit-implementation-plan.md §3): package 011 — SERP feature normalization and rendering for PAA, featured snippet, local pack, images, video, shopping, news, knowledge graph, sitelinks, and related searches (no fabricated features; PAA placement rule preserved); mobile card view (position/result/summary with metrics in expansion); Dashboard intelligence sections (A1) built on the 001 stored-rollup contracts; unified 11-state section model (A2) with deterministic service-to-view mapping. Implements PR7 (S4–S5, S9) + PR12 (A1) + PR13 (A2). Consumes the 003 SERP contract as mandatory input; base SERP must survive enrichment failure."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See normalized SERP features on keyword/result views (Priority: P1)

An SEO analyst looking at a tracked keyword's SERP sees the actual SERP features present — People
Also Ask, featured snippet, local pack, image pack, video carousel, shopping results, news box,
knowledge panel/graph, sitelinks, and related searches — normalized into one consistent shape and
rendered with clear labels. Every rendered feature comes from a real provider response for that
SERP. If the provider did not return a feature type, that type is absent from the view — never
fabricated, never shown as an empty card that implies "we measured none."

**Why this priority**: SERP features decide click-through opportunity; without them an analyst
cannot tell whether position 3 even gets seen (e.g., below a featured snippet and a local pack).
This is the foundation package PR7 gates on, and the features surface is reused by the detectors
and reports built later.

**Independent Test**: Can be fully tested by seeding stored SERP analyses containing a known mix
of feature types, loading the SERP view, and asserting that exactly the stored features render with
their presence, placement, and ownership attributes — with zero fabricated entries and no
detector/dashboard involvement.

**Acceptance Scenarios**:

1. **Given** a SERP analysis whose stored payload includes People Also Ask and a featured snippet,
   **When** the analyst opens the SERP view for that keyword, **Then** both features appear
   normalized: PAA shown as a set of questions, snippet shown with its source result, and both
   placed according to their recorded position rules (PAA placement preserved per S9: PAA does not
   displace organic results in the positional list).
2. **Given** a SERP payload that contains no local pack and no knowledge panel, **When** the view
   renders, **Then** those feature types are simply absent — there is no placeholder card, no zero
   count presented as a measurement, and no inferred feature not present in the stored payload.
3. **Given** SERPs returned by different supported providers for the same feature type (e.g., a
   video carousel), **When** stored and rendered, **Then** the analyst sees one consistent feature
   shape and label regardless of provider (Constitution: provider set/semantics are normalized at
   the boundary).

---

### User Story 2 - Read SERP results comfortably on mobile (Priority: P2)

An analyst on a phone opens a keyword's SERP view and gets a card-based layout: each result card
shows its position, the result itself (title/snippet/domain), and a one-line summary; detailed
metrics are tucked into an expandable section rather than squeezed into the card. No content
overflows the viewport, and feature blocks (PAA, local pack, etc.) render within the same card
rhythm instead of breaking the layout.

**Why this priority**: Analysts check rankings on the go; a desktop-only dense table makes the
product unusable in exactly the quick-check scenario. It is independent of the dashboard sections
story and can ship with Story 1 only.

**Independent Test**: Can be fully tested by rendering a seeded SERP with feature blocks at mobile
viewport widths and asserting: no horizontal overflow, each card shows position + result + summary,
metrics appear only after expansion.

**Acceptance Scenarios**:

1. **Given** a tracked keyword SERP viewed at a narrow (mobile) viewport, **When** the results
   render, **Then** each result is a card showing position, result identity, and summary, and no
   element overflows horizontally.
2. **Given** a result with multiple metrics, **When** the analyst taps to expand, **Then** the
   full metric set appears inside the expansion without reflowing sibling cards.

---

### User Story 3 - See project intelligence sections on the Dashboard (Priority: P3)

A project owner opens the project Dashboard and sees intelligence sections — such as the
opportunities summary, recent findings, sync freshness, and usage/rollup summaries (A1) — each
computed from the stored-rollup contracts delivered in wave 1 (001), not from render-time
computation or live provider calls. Sections render fast from stored data and match what the
detail pages would show.

**Why this priority**: The dashboard is the daily entry point; without these sections the
intelligence built in waves 1–2 is invisible. It builds only on what already exists (stored
rollups), so it is a pure surfacing story — but it must wait for the data contracts and therefore
comes after Stories 1–2 in value ordering, not because of size but because of dependency.

**Independent Test**: Can be fully tested by seeding stored rollups/findings for a project,
loading the Dashboard, and asserting each section's numbers equal the stored-rollup values — with
a disconnected-project state rendered honestly when no rollups exist.

**Acceptance Scenarios**:

1. **Given** a project with stored rollups present, **When** the owner opens the Dashboard,
   **Then** every intelligence section reads from stored rollups and the displayed totals match
   the corresponding detail views for the same period.
2. **Given** a project whose data source is not connected, **When** the Dashboard loads, **Then**
   the affected sections render a not-connected / no-data state — never zeros dressed as measured
   facts.

---

### User Story 4 - Trust a unified section state model across all dashboard sections (Priority: P3)

Every dashboard section — existing and new — renders through one unified state model with eleven
deterministic states (for example: loading, ready, empty, not-connected, no-permission,
syncing, partially-available, failed, stale, unavailable, upgrade-required — exact enumeration is
finalized at planning time against the existing section model), mapped deterministically from the
service-layer result to the view state. The owner never sees a half-loaded or contradictory
section: one service outcome always produces one view state, and failure states are explicit and
distinct from empty states.

**Why this priority**: As sections multiply, ad-hoc per-section state logic drifts into dishonest
states (failure shown as zero; sync-in-progress shown as done). A unified model is the correctness
backbone (A2) that keeps every current and future section truthful — it is the same priority band
as Story 3 because it lands with the sections it governs.

**Independent Test**: Can be fully tested by driving each section's service result through the
mapping function in tests (state matrix) and asserting that for each of the 11 states the rendered
view matches the specified state — including failure ≠ empty and partial ≠ complete.

**Acceptance Scenarios**:

1. **Given** a section whose underlying read failed, **When** the dashboard renders, **Then** the
   section shows its failed state with a retry affordance — never an empty state or a zero.
2. **Given** every service outcome enumerated in the state matrix, **When** mapped to a view,
   **Then** exactly one deterministic state results, and state-matrix tests cover all 11 states.
3. **Given** a feature-flagged or plan-gated section, **When** the project lacks access, **Then**
   the section renders its unavailable/upgrade state rather than silently disappearing.

---

### Edge Cases

- **Enrichment failure after base SERP stored**: if competitive/feature enrichment (007) fails for
  a keyword, the base SERP and its stored features still render fully; enrichment fields degrade to
  absent, not errors that blank the view.
- **Provider omits a feature type entirely**: never rendered (no fabrication), and no "feature
  not detected" wording that implies measurement.
- **Unknown/unmapped feature type in a provider payload**: safely ignored with trace entry, never
  rendered and never crashing the SERP view.
- **Duplicate feature entries in a payload**: deduplicated defensively at normalization; dedupe is
  observational (logged), not silent data loss.
- **Rollups missing for a covered period**: the dashboard section shows its no-data state; it does
  not fall back to computing from raw grains at render time.
- **Two service outcomes arriving mid-render (stale then fresh)**: the unified model resolves to a
  single deterministic state per the mapping, never a flicker of contradictory states.
- **Mobile + very long PAA question lists**: PAA blocks remain bounded/collapsible within the card
  rhythm without horizontal overflow.

## Requirements _(mandatory)_

### Functional Requirements

**SERP feature normalization (PR7 / S4–S5, S9)**

- **FR-001**: System MUST normalize the following SERP feature types into a single provider-agnostic
  feature model when present in stored SERP payloads: People Also Ask, featured snippet, local pack,
  image pack, video, shopping, news, knowledge graph/panel, sitelinks, and related searches.
- **FR-002**: System MUST render only features that exist in the stored SERP payload for that SERP;
  absence of a feature type in the payload MUST result in absence from the view (no fabrication, no
  placeholder-as-zero).
- **FR-003**: People Also Ask MUST be rendered as its own feature block per the placement rule
  (S9): PAA presence/position is recorded as a feature attribute and MUST NOT displace or renumber
  organic results in the positional list.
- **FR-004**: Feature rendering MUST carry the attributes stored for that feature (placement/
  position where recorded, ownership where attributable, and payload-specific sub-items such as PAA
  questions or sitelink links) using correlational/observational language only.
- **FR-005**: Feature types not recognized by the normalizer MUST be dropped safely at the
  normalization boundary with a trace entry; they MUST NOT reach the view and MUST NOT fail the
  SERP load.
- **FR-006**: When feature/competitive enrichment fails for a keyword, the base SERP and its stored
  features MUST still render completely; the failure degrades only the enrichment fields and is
  surfaced as an explicit degraded/unavailable indicator, not as an error over the whole SERP view.

**Mobile SERP card view (PR7 / S9 UI)**

- **FR-007**: System MUST render SERP results as cards at mobile viewport widths: each card shows
  position, result identity (title/snippet/domain), and a one-line summary; full metrics MUST be
  inside an expandable section of the card.
- **FR-008**: No SERP view at supported mobile widths MUST overflow horizontally; feature blocks
  MUST render within the same card rhythm as organic results.

**Dashboard intelligence sections (PR12 / A1)**

- **FR-009**: Dashboard intelligence sections (opportunities summary, recent findings, sync
  freshness, and rollup/usage summaries) MUST read exclusively from stored rollups and stored
  findings delivered by the 001 contracts — no render-time provider calls and no render-time
  recomputation from raw grains.
- **FR-010**: Dashboard section values MUST equal the values shown on the corresponding detail
  views for the same period and project.
- **FR-011**: A project without a connected source MUST render dashboard sections in their
  not-connected/no-data state — never as zeros presented as measurements.

**Unified 11-state section model (PR13 / A2)**

- **FR-012**: Every dashboard section MUST resolve its view through a single deterministic
  service-to-view state mapping covering 11 states (enumeration fixed at planning time from the
  existing section model; must include at minimum: loading, ready, empty/no-data, not-connected,
  no-permission, syncing, partially-available, failed, stale, unavailable, upgrade-required).
- **FR-013**: The state mapping MUST be deterministic: one service outcome produces exactly one
  view state, and the full state matrix MUST be covered by automated tests.
- **FR-014**: Failure states MUST be visually and programmatically distinct from empty states; a
  failed read MUST render the failed state with a retry affordance and MUST NOT render empty or
  zero content.

**Cross-cutting**

- **FR-015**: All reads in scope MUST be over stored data (SERP analyses, rollups, findings); no
  new render-time paid provider calls are permitted (Constitution G10).
- **FR-016**: Any new or changed MCP-facing surfaces MUST be thin wrappers over the same services —
  no parallel read paths (Constitution: one-engine/layering rules).

### Key Entities

- **SERP Feature**: A normalized, provider-agnostic representation of one SERP feature within a
  stored SERP analysis; attributes include feature type, placement/position (where recorded),
  ownership (where attributable), and type-specific sub-items (e.g., PAA questions, sitelink
  links). Belongs to a stored SERP analysis; never exists without a stored payload row.
- **Dashboard Section**: A discrete intelligence panel on the project Dashboard backed by stored
  rollups/findings; has exactly one state drawn from the unified 11-state model at any render.
- **Section State (11-state model)**: A deterministic enumeration mapping service outcomes to view
  states; shared by all dashboard sections and covered by a state-matrix test suite.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of stored SERP payload feature types in the supported list are normalized and
  rendered for seeded fixtures; 0 fabricated features appear when a type is absent from the
  payload (verified by fixture tests).
- **SC-002**: All 11 states of the section state model are exercised by automated state-matrix
  tests; every dashboard section renders exactly the state its service outcome dictates.
- **SC-003**: At mobile viewport widths, 0 horizontal-overflow violations across the SERP view and
  its feature blocks (verified by E2E viewport tests).
- **SC-004**: Every Dashboard intelligence section's displayed totals equal the stored rollup
  values for the same project and period (verified by stored-data tests).
- **SC-005**: When enrichment for a keyword fails (simulated), the base SERP view still loads
  completely for 100% of base data; only enrichment-only fields are degraded.
- **SC-006**: Analysts on mobile can read position, result, and summary for every visible result
  without any expansion, and reach full metrics in one tap.

## Assumptions

- **Input contract is frozen**: spec 003's SERP analysis contract is the mandatory input for this
  package; normalization consumes the stored payload shape and does not redefine it (any contract
  discrepancy is resolved code-authoritative per the wave-1 decision).
- **Placement semantics**: the PAA placement rule (S9) — PAA tracked as a feature, not as an
  organic position displacement — is preserved from existing behavior and 007 enrichment rules.
- **Provider boundaries already normalize units**: provider set/semantics handled at ingestion
  (Constitution P6–P10); this package normalizes feature *shape*, not provider credentials/quotas.
- **Rollups exist and are authoritative**: wave-1 (001) stored-rollup contracts are stable; the
  Dashboard sections add no new rollup definitions, only readers.
- **11-state enumeration exists to extend**: an existing per-section state model is present in the
  codebase; this package unifies/enumerates it into 11 named states rather than inventing a new
  mechanism (exact state names finalized at plan time).
- **No new schema**: this package introduces no new database tables; it reads SERP payloads,
  rollups, and findings already persisted by earlier specs. If planning discovers a storage gap,
  it must be raised back to the plan's `Needs` gates rather than added silently.
- **Mobile means card view only**: desktop SERP rendering remains the existing table/dense view;
  this package adds the mobile card view, not a desktop redesign.
