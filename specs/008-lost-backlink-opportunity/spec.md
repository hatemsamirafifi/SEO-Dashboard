# Feature Specification: Lost-Backlink Opportunity

**Feature Branch**: `008-lost-backlink-opportunity`

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: "Split lost-backlink detection out of the general backlink-change finding into its own prioritized opportunity: detect referring domains that stopped linking between consecutive stored backlink snapshots, with a loss floor that separates notable losses from noise, frozen evidence naming the lost domains, and provider failure never classified as loss (G9). Uses the existing stored backlink snapshot inputs and the existing detector/materializer/opportunity model — no second engine, no new scoring model (G3). Implements Track C milestone C2a of the Final Revised Implementation Plan (PR9, Wave 2)."

## Clarifications

### Session 2026-09-30

- Q: What should the default loss floor be before a lost-backlink opportunity is emitted? → A: 3 lost referring domains (binding):
  1. Emit only when lost referring domains ≥ 3 (exactly 3 satisfies the floor) and the detector's other
     evidence/coverage conditions hold; 1 or 2 lost referring domains never emit by default.
  2. The floor is a configurable detector threshold following the existing threshold conventions —
     versioned/documented, tunable later or overridable per project where the configuration model supports
     it — not a hard-coded business truth.
  3. Referring-domain loss is the primary floor, not raw backlink-count loss: multiple backlinks can
     disappear from a single domain and inflate noise.
  4. Provider/API failure is never interpreted as lost domains; missing or partial coverage must not
     trigger the detector unless the existing detector contract explicitly proves the loss from valid
     stored snapshots.
  5. Floor tests required: 0, 1, 2 lost referring domains → no opportunity; 3 → eligible; 5+ → eligible;
     provider failure → none; insufficient coverage → none; supported threshold override → respected.

## Clarifications

### Session 2026-09-30

- Q: What should the default loss floor be — the minimum number of lost referring domains required before a lost-backlink opportunity is emitted? → A: 3 lost referring domains (binding):
  1. Emission requires `lostReferringDomains >= 3` plus the detector's other evidence/coverage conditions;
     the floor is a configurable, versioned detector threshold (existing threshold conventions), not a
     hard-coded business truth.
  2. The floor counts lost **referring domains**, not raw backlink-count loss — multiple backlinks
     vanishing from one domain is one lost domain, not noisy inflation.
  3. Boundary tests required: 0/1/2 lost RD → no opportunity; exactly 3 → eligible; 5+ → eligible;
     provider failure → no opportunity; insufficient coverage → no opportunity; explicit threshold
     override respected where the configuration model supports it.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See notable lost backlinks as a prioritized opportunity (Priority: P1)

An SEO manager opens the Opportunities list after an intelligence scan and finds a "lost backlinks"
opportunity — not buried inside a general backlink-change summary. It names the referring domains that
stopped linking between the two most recent stored snapshots, shows the aggregate impact, and carries a
priority derived from the existing scoring model. Minor noise (a single low-value link disappearing) does
not produce an opportunity.

**Why this priority**: Lost links are the highest-urgency backlink signal (they directly explain ranking or
traffic loss); giving them their own opportunity is the entire point of C2a.

**Independent Test**: Can be fully tested by seeding two consecutive snapshots with a known set of lost
referring domains above the loss floor, running the detector + materializer, and asserting one
prioritized opportunity exists whose evidence names exactly those domains.

**Acceptance Scenarios**:

1. **Given** two consecutive stored backlink snapshots where 5 referring domains present in the earlier are
   absent in the later, **When** the scan runs with a loss floor of 3, **Then** one lost-backlink
   opportunity is emitted, its evidence names the 5 lost domains, and its impact/confidence scores follow
   the existing separate-score model.
2. **Given** a scan where only 1 referring domain disappeared, **When** the loss floor is 3, **Then** no
   lost-backlink opportunity is emitted (below floor is not notable).
3. **Given** the existing general backlink-change finding, **When** the lost-link opportunity is emitted,
   **Then** the general change finding continues to exist unchanged — the split adds a focused opportunity
   without removing or duplicating the existing signal.

---

### User Story 2 - Provider failure never looks like link loss (Priority: P2)

A backlink data refresh fails or returns partial data before the next scan. The manager sees no
"lost backlinks" opportunity claiming domains vanished — a failed or partial fetch is distinguishable from
a genuinely observed loss. Confidence is capped or the detector skips entirely when coverage is
insufficient, and the evidence always states which two snapshots were compared.

**Why this priority**: A false "you lost 40 backlinks" alert from a provider outage would destroy trust and
trigger wasted outreach (Constitution P8/P28, G9).

**Independent Test**: Can be tested by seeding a failed/partial snapshot sync followed by a scan and
asserting no loss opportunity is emitted, plus verifying the evidence cites snapshot timestamps for every
real emission.

**Acceptance Scenarios**:

1. **Given** a snapshot sync that failed or returned partial data, **When** the scan runs, **Then** no
   lost-backlink opportunity is emitted from that gap, and the run records the gap explicitly.
2. **Given** consecutive snapshots with insufficient coverage for a confident comparison, **When** the
   detector evaluates, **Then** it either skips with a documented reason or emits with capped confidence
   — never at full confidence.
3. **Given** any emitted lost-backlink opportunity, **When** the user inspects its evidence,
   **Then** the evidence is frozen and includes the compared snapshot timestamps (from/to), so the claim
   is verifiable later.

---

### User Story 3 - Opportunities integrate with the existing lifecycle (Priority: P3)

The manager triages the lost-backlink opportunity like any other: it appears in the standard Opportunities
list with filters, moves through the existing lifecycle states (open → in progress → completed/dismissed),
its events are recorded in the durable opportunity event ledger exactly once, and re-scans over the same
snapshot pair do not duplicate it.

**Why this priority**: The opportunity is only useful if it lives inside the existing workflow users already
operate; a parallel list or duplicated events would violate the single-model rule (G3).

**Independent Test**: Can be tested by emitting the opportunity, re-running the scan over the same snapshots,
and asserting the ledger shows the original event exactly once and the lifecycle transitions behave like
existing opportunity types.

**Acceptance Scenarios**:

1. **Given** an emitted lost-backlink opportunity, **When** the same scan input re-runs, **Then** no
   duplicate opportunity is created (idempotent emission over the same snapshot pair and domain set).
2. **Given** the opportunity in the list, **When** the user moves it to in-progress then dismisses it with
   a reason, **Then** each transition is recorded in the event ledger once, identically to existing
   opportunity types.
3. **Given** the Opportunities list filters, **When** the user filters by the lost-backlinks type, **Then**
   only lost-backlink opportunities appear, using the existing filter surfaces.

---

### Edge Cases

- Only one snapshot exists (first-ever capture): detector skips — a two-point comparison is impossible;
  skip is documented, not an error.
- Snapshots too far apart (beyond the freshness window): treated as insufficient coverage per the
  existing coverage gating, not as a confident loss observation.
- A domain disappears but also new domains appear: loss detection considers losses independently of gains;
  the aggregate change finding already covers net movement.
- A lost domain reappears in a later snapshot: the historical loss opportunity remains as emitted (it was
  true for that pair); a future re-gain may inform a separate finding per existing rules.
- Lost-domain list very large: evidence is bounded (top-N named domains plus the aggregate count) — the
  full list is retrievable, evidence itself stays reviewable.
- Domain normalization differences (www vs bare, case): targets are compared on normalized domain identity
  so a renamed-but-same link never counts as lost.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST detect lost referring domains by comparing two consecutive stored backlink
  snapshots (the two most recent, per existing freshness-window rules) and MUST emit a dedicated
  lost-backlink opportunity through the existing detector and materializer pipeline — no parallel engine
  or second scoring model (G3).
- **FR-002**: Detection MUST apply a configurable loss floor (minimum number of lost referring domains)
  separating notable losses from noise; the default floor is 3 lost referring domains (exactly 3
  satisfies it), governed as a versioned, tunable detector threshold — referring-domain loss is the
  primary floor, not raw backlink-count loss. Losses below the floor MUST NOT emit an opportunity.
- **FR-003**: Evidence MUST be frozen at emission and MUST include the lost referring domains (bounded
  top-N plus aggregate count), the compared snapshot timestamps, and the loss delta — verifiable later
  without re-deriving.
- **FR-004**: Provider failure, partial data, or insufficient coverage MUST NOT produce a loss opportunity:
  failed/incomplete comparisons MUST skip or emit with capped confidence per the existing coverage-gating
  rules, and skips MUST be recorded with their reason (G9, Constitution P28).
- **FR-005**: Domain comparison MUST use the existing shared domain-identity normalization so that alias
  or case differences never count as a lost link.
- **FR-006**: Emission MUST be idempotent per snapshot pair and domain set: re-running the scan over the
  same inputs MUST NOT duplicate the opportunity or its events in the durable ledger.
- **FR-007**: The opportunity MUST appear in the existing Opportunities list, filters, and lifecycle
  (open/in-progress/completed/dismissed with reason), indistinguishable in workflow from existing types.
- **FR-008**: The existing general backlink-change finding MUST remain unchanged: the lost-link split adds
  a focused opportunity and MUST NOT remove, rewrite, or double-count the aggregate signal.
- **FR-009**: Scoring MUST preserve the existing separate impact and confidence model; where backlink
  history is labeled heuristic (short two-point baseline), confidence MUST stay capped as in the existing
  backlink-change labeling.

### Key Entities

- **LostBacklinkOpportunity**: One prioritized opportunity of the lost-backlinks type; key attributes are
  the domain set lost, the compared snapshot pair, the loss delta, impact/confidence scores (separate),
  and lifecycle state.
- **BacklinkSnapshotPair**: The two most recent stored backlink snapshots compared, identified by capture
  timestamps; the authoritative input — never a live fetch.
- **LostDomainEvidence**: Frozen evidence block: named lost domains (bounded), aggregate counts, snapshot
  timestamps, and coverage state of the comparison.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Seeded snapshot pairs produce exactly one lost-backlink opportunity when the loss floor is
  met — floor boundary verified: 0, 1, and 2 lost referring domains emit nothing; exactly 3 and 5+ are
  eligible (evidence naming the lost domains, scores split into impact and confidence) — and a supported
  threshold override, where offered, is respected.
- **SC-002**: Across all seeded failure modes (failed sync, partial data, single-snapshot history,
  stale-pair coverage), zero false loss opportunities are emitted and every skip is recorded with a reason.
- **SC-003**: Re-running the scan over identical inputs produces zero duplicate opportunities and zero
  duplicate ledger events (idempotency verified over at least two re-runs).
- **SC-004**: The lost-backlink opportunity completes the full lifecycle (open → in progress →
  completed/dismissed) through the existing surfaces with 100% of lifecycle events recorded, and the
  aggregate backlink-change finding still emits for the same input.

## Assumptions

- Stored backlink snapshots (the existing two-point diff inputs) are the sole input; no new provider call
  is added by this feature.
- The loss floor default (3 lost referring domains) and its tunable range follow the existing
  detector-threshold conventions (configurable like other detector thresholds, versioned and documented);
  referring-domain grain is the floor's unit — raw backlink-count loss does not satisfy the floor.
- Impact/confidence scoring reuses the existing backlink-change template conventions, including its
  two-point-heuristic confidence cap; no new scoring factors are invented.
- The "top-N named domains plus aggregate count" bound for evidence keeps the frozen evidence reviewable;
  the full list remains available through the existing evidence-detail surfaces where other opportunity
  types expose detail.
- Domain-grain identity only; page-level backlink loss is out of scope (page-grain joins are gated on
  spec 006's canonical identity and belong to later page-grain work).
- No UI redesign: the opportunity renders through the existing opportunity templates and list surfaces.
