# Feature Specification: Striking Distance Detector

**Feature Branch**: `004-striking-distance-detector`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Add a deterministic striking-distance detector (positions ~11–20 with meaningful impressions) to the existing Intelligence Engine detector registry with versioning, coverage gating, and frozen evidence. Must not trigger on insufficient impressions, incomplete coverage, or failed/unavailable rank data. Reconcile the 11–20 detector band with the existing GSC helper's 5–20 band. Implements Track C milestone C1 of the Final Revised Implementation Plan (PR8); existing opportunity model stays frozen (G3)."

## Clarifications

### Session 2026-09-28

- Q: Which position band counts as "striking distance" for the detector? → A: Detector uses positions 11–20; the existing GSC helper keeps 5–20 as a broader near-miss/dashboard view explicitly documented as a superset. The two meanings are distinguished in code (detector band constants plus a superset comment on the helper) so "striking distance" never has two silent definitions.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Surface page-one-adjacent keywords as opportunities (Priority: P1)

An SEO reviews the Opportunities list and finds keywords ranking just off page one (positions 11–20)
with meaningful impression volume, each with frozen evidence (positions, impressions, clicks, windows,
thresholds applied) and a materialized recommendation — stable across scans so the same keyword doesn't
duplicate week to week.

**Why this priority**: Striking-distance keywords are the highest-ROI quick wins; this is the entire
point of C1.

**Independent Test**: Can be fully tested with fixture GSC/rank inputs containing known 11–20 keywords
above and below the impression floor, verifying exactly the qualifying set materializes as opportunities.

**Acceptance Scenarios**:

1. **Given** a keyword at position 14 with impressions above the floor over covered windows,
   **When** a scan runs, **Then** a striking-distance opportunity exists with frozen evidence and stable
   identity across the next scan.
2. **Given** a keyword at position 8 (page one) or 35 (deep), **When** a scan runs,
   **Then** no striking-distance opportunity is created for it.

---

### User Story 2 - Never invent opportunities from missing or failed data (Priority: P2)

When impressions are thin, coverage is incomplete, or rank data failed, the detector stays silent for the
affected entities — the owner sees fewer opportunities, never false ones, and coverage-gated skips are
recorded in the scan ledger.

**Why this priority**: A detector that fires on failed inputs destroys trust in the whole Opportunities
surface (constitutional invariant).

**Independent Test**: Can be tested with fixture inputs for each failure mode (low impressions, partial
coverage, failed rank run) verifying zero emissions and recorded skip reasons.

**Acceptance Scenarios**:

1. **Given** a position-13 keyword with impressions below the floor, **When** a scan runs,
   **Then** no opportunity is created.
2. **Given** a failed rank run for the window, **When** a scan runs,
   **Then** no striking-distance opportunities are created from rank-dependent logic, and the skip is
   recorded with reason.
3. **Given** incomplete GSC coverage for the window, **When** a scan runs,
   **Then** affected entities are skipped (not scored), with the skip recorded.

---

### User Story 3 - Manage the opportunity lifecycle without duplicates (Priority: P3)

Re-detection of an active striking-distance key updates it in place (scores, evidence, last-seen);
terminal (completed/dismissed) rows are never resurrected — recurrence creates a linked new occurrence;
a detector major-version change supersedes old rows with linkage.

**Why this priority**: Identity stability is what makes the detector production-safe across scheduled scans.

**Independent Test**: Can be tested by running detection twice over the same fixtures plus lifecycle
transitions, verifying single active rows, event ledger entries, and recurrence linkage.

**Acceptance Scenarios**:

1. **Given** an active striking-distance opportunity, **When** the next scan re-detects it,
   **Then** one row is updated in place (status preserved) with a re-detection event.
2. **Given** a dismissed striking-distance opportunity, **When** the keyword re-qualifies later,
   **Then** a new linked occurrence is created and the dismissed history is untouched.

---

### Edge Cases

- What happens at the exact band edges (position 10 vs 11, 20 vs 21)? Band membership is inclusive and
  documented; edge fixtures pin the behavior.
- What happens when a keyword sits in-band on one URL but the query has multiple ranking URLs?
  Entity identity is per query (with documented URL handling); the evidence names the observed URL(s).
- What happens when GSC shows the keyword but rank snapshots are missing for the window? Rank-missing is
  treated as unavailable input per the no-trigger rules, not as position zero.
- How does the detector band relate to the existing GSC helper's 5–20 band? Planning reconciles them to
  one documented rule (assumption below); helper and detector never silently disagree.
- What happens on re-detection with materially changed evidence? Scores/evidence update with threshold-gated
  events (no event spam for noise-level changes).

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The detector MUST emit findings only for keywords in the striking-distance band (positions
  11–20 inclusive, defined once as detector band constants) with impressions at or above the documented
  floor, over fully covered windows. The existing GSC helper's broader 5–20 near-miss range is retained
  for dashboard/view purposes and MUST be explicitly documented in code as a superset of the detector band.
- **FR-002**: The detector MUST NOT emit when impressions are below the floor, required coverage is
  incomplete, or rank/source data failed or is unavailable — recording a skip reason in the scan ledger.
- **FR-003**: The detector MUST register in the existing versioned detector registry (explicit list, no
  auto-discovery) with a stable detector key and version; exactly one detector owns this SEO condition.
- **FR-004**: Findings MUST carry frozen evidence (metrics, periods, sources, source references, thresholds
  applied) with fact-only content; recommendations are added exclusively by the existing materializer.
- **FR-005**: Opportunity identity MUST be stable across scans (deterministic logical key); re-detection
  updates in place, terminal rows are never reopened, recurrence links forward, version-major changes
  supersede with linkage.
- **FR-006**: The existing opportunity model (identity, lifecycle, scoring, events) MUST NOT be redesigned
  by this feature; the detector plugs into it unchanged (G3).
- **FR-007**: The position band and impression floor MUST be injected thresholds echoed in evidence, never
  hardcoded shared band constants, and the helper's broader near-miss range (5–20) MUST be documented
  in code as a superset of the detector band, so the two never silently disagree.

### Key Entities

- **StrikingDistanceFinding**: One detector observation; attributes include keyword entity key, position,
  impressions/clicks, windows, sources, thresholds applied, and confidence inputs.
- **OpportunityOccurrence**: The lifecycle row materialized from the finding; attributes include logical key,
  status, impact/confidence scores, frozen evidence, and recurrence/supersession links.
- **CoverageSkip**: A recorded decision not to evaluate an entity/detector due to missing or failed inputs,
  with reason, visible in the scan ledger.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: On a fixture set with known in-band/out-of-band and above/below-floor keywords, the detector
  emits opportunities for exactly the qualifying set — 100% precision and recall against the fixture labels.
- **SC-002**: On fixture sets for each failure mode (low impressions, partial coverage, failed rank),
  the detector emits zero opportunities and records a skip reason for every affected entity.
- **SC-003**: Two consecutive scans over unchanged fixtures produce zero duplicate opportunity rows and
  update last-seen state correctly.
- **SC-004**: A dismissed opportunity that re-qualifies yields a new linked occurrence with the dismissed
  history preserved untouched.

## Assumptions

- Detector band is positions 11–20 inclusive with a documented impressions floor (clarified 2026-09-28);
  the existing GSC helper's 5–20 band is retained as a broader near-miss/dashboard view explicitly documented
  as a superset — helper and detector MUST NOT silently disagree.
- Impact/confidence scoring, priority matrix, and event emission thresholds of the existing materializer are
  reused unchanged.
- Scan scheduling/cadence is owned by the existing intelligence scheduler; this feature only adds the detector.
