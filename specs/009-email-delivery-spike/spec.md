# Feature Specification: Email Delivery Infrastructure Spike

**Feature Branch**: `009-email-delivery-spike`

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: "Time-boxed verification spike of the existing email infrastructure (Loops) for scheduled report delivery: prove or disprove quota, sender identity, transactional template ownership, failure semantics, retry/idempotency behavior, and self-hosted degradation honestly. The output is exactly one recorded verdict — EMAIL_DELIVERY_READY or EMAIL_DELIVERY_BLOCKED — with evidence. If BLOCKED, no delivery code ships and scheduled reports (spec 012) stay Draft. This is the G6 decider for Track D milestone D2a of the Final Revised Implementation Plan (PR15, Wave 2). Verification only — no production delivery feature, no new provider, no new scheduled-send code."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Record an evidence-backed verdict (Priority: P1)

The team needs to know whether scheduled report emails can ship. A time-boxed spike runs the existing email
path through a checklist of delivery-relevant questions (quota and rate limits, sender identity, template
ownership, send/failure semantics, duplicate-send behavior, environment degradation). Its only deliverable
is a verdict — READY or BLOCKED — recorded with the evidence trail: what was tested, what was observed,
what was assumed, and what was explicitly not verified.

**Why this priority**: The verdict is the entire value of the spike; G6 blocks scheduled reports until it
exists.

**Independent Test**: Can be fully tested by reviewing the recorded verdict artifact and confirming it
contains exactly one verdict value, the evidence checklist with observed results, and the open questions —
independent of any code change.

**Acceptance Scenarios**:

1. **Given** the completed spike, **When** the verdict is read, **Then** it is exactly one of
   EMAIL_DELIVERY_READY or EMAIL_DELIVERY_BLOCKED, with each checklist item marked verified/observed or
   explicitly not-verified with reason.
2. **Given** the spike's end, **When** the verdict is recorded, **Then** spec 012's status resolves
   deterministically: READY unblocks its planning; BLOCKED keeps it Draft with the recorded reason.
3. **Given** the evidence, **When** a maintainer reviews it, **Then** every claim links to how it was
   observed (test, log excerpt, or documented provider behavior) — no unbacked assertions.

---

### User Story 2 - Honest failure and degradation answers (Priority: P2)

The spike specifically answers the questions that would bite in production: what happens when a send
fails (is the failure observable and classified), what happens if the same scheduled email is attempted
twice (is the outcome safe to retry), what happens without credentials or on a self-hosted deployment
(does email degrade honestly rather than silently), and whether transactional templates are owned and
configurable by this deployment rather than assumed shared.

**Why this priority**: These are the failure modes that make scheduled delivery untrustworthy; G6 exists
because an unverified path must not carry a production feature.

**Independent Test**: Can be tested by the spike's own recorded observations — each failure/degradation
question in the checklist must have an observed answer (or an explicit not-verified with reason).

**Acceptance Scenarios**:

1. **Given** an injected send failure during the spike, **When** the path is observed, **Then** the failure
   is visible, classified (transient vs permanent), and does not masquerade as success.
2. **Given** a duplicate-send attempt of the same logical email during the spike, **When** observed,
   **Then** the behavior is recorded — whether duplicate-safe by design or requiring idempotency
   machinery in 012 — with the evidence.
3. **Given** a missing-credentials environment during the spike, **When** the email path runs, **Then**
   degradation is explicit (logged skip with reason) rather than a silent no-op that looks like a sent
   email.
4. **Given** the spike's template check, **When** transactional templates are inspected, **Then** the spike
   records whether the required templates exist, are owned/configurable by this deployment, and what
   happens when a template reference is invalid.

---

### Edge Cases

- Spike time-box expires with checklist incomplete: verdict MUST be BLOCKED by default (unverified ≠
  ready), with the incomplete items named — not silently downgraded to READY.
- A provider limitation is discovered (e.g. quota too small for projected schedule volume): verdict is
  BLOCKED with the limitation as primary evidence, unless a bounded workaround is verified within the box.
- Evidence depends on a live provider condition that cannot be tested (e.g. account not provisioned):
  recorded as not-verified with reason; it counts against READY per the rule above.
- Findings that suggest delivery could be READY _with_ changes: those changes belong to spec 012 (or a
  future package), never to this spike — the spike records them as required-prerequisites, it does not
  implement them.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The spike MUST verify, within its time-box, the existing email delivery path against a
  checklist covering at minimum: send quota and rate limits, sender identity, transactional template
  ownership and configuration, send success and failure semantics (including classification of transient
  vs permanent failures), duplicate-send/retry behavior, and missing-credentials/self-hosted degradation.
- **FR-002**: The spike's output MUST be exactly one recorded verdict — EMAIL_DELIVERY_READY or
  EMAIL_DELIVERY_BLOCKED — persisted with its evidence checklist and observable by the team.
- **FR-003**: Every checklist item MUST be marked as either observed-with-evidence or
  not-verified-with-reason; an incomplete checklist at time-box expiry MUST yield BLOCKED.
- **FR-004**: The spike MUST NOT implement production delivery behavior, add or replace an email provider,
  alter existing auth/transactional email flows, or ship scheduled-send code (Constitution P50 scope
  discipline).
- **FR-005**: Credentials, API keys, and recipient addresses used during verification MUST NOT appear in
  the recorded evidence (secret-free evidence).
- **FR-006**: The verdict MUST gate spec 012 (scheduled reports): READY unblocks its planning; BLOCKED
  keeps 012 Draft with the recorded reason until a later verified attempt.

### Key Entities

- **DeliveryVerdict**: The single recorded outcome (READY/BLOCKED) plus timestamp and author/run context;
  the authoritative G6 record.
- **EvidenceChecklist**: The set of verified delivery questions, each with observed result, method, and
  evidence reference — or an explicit not-verified reason.
- **RequiredPrerequisite**: A change the spike identified as necessary before scheduled delivery can ship
  (recorded for 012, never implemented by the spike).

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Within the time-box, exactly one verdict exists, persisted and readable by the team, with
  100% of checklist items marked observed-with-evidence or not-verified-with-reason (zero unmarked items).
- **SC-002**: Every evidence claim carries an observation method (test, log excerpt, or documented
  behavior) — an audit of the evidence artifact finds zero unbacked assertions.
- **SC-003**: Spec 012's lifecycle state matches the verdict deterministically: READY → 012 may enter
  planning; BLOCKED → 012 remains Draft, and the recorded reason is discoverable from 012's status.
- **SC-004**: The spike leaves zero production behavior changes: no new delivery code paths, no provider
  changes, and no altered email flows (verified by reviewing what the spike actually merged, if
  anything).

## Assumptions

- The existing email infrastructure (the transactional email path already used for auth flows) is the
  system under verification; no alternative provider is evaluated inside this time-box.
- Verification uses non-production recipients and clearly labeled test content; no real client emails are
  sent.
- The spike may add throwaway verification harnesses/tests, but anything merged must be evidence tooling
  or documentation only — never production delivery behavior.
- Scheduled reports themselves (cadence, ledger, generation) are spec 012's concern; this spike answers
  only "can we reliably deliver email through the existing path".
- Self-hosted deployments are part of the degradation question: the spike records what happens when the
  email path is unconfigured, not merely whether hosted mode works.
- The time-box and its deadline are set at spike start; expiry with incomplete checklist means BLOCKED
  (the honest default).
