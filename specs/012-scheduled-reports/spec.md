# Feature Specification: Scheduled Reports (weekly/monthly email delivery)

**Feature Branch**: `012-scheduled-reports`

**Created**: 2026-10-03

**Status**: Partially implemented — **US1 (schedules/management) = READY, US2 (exactly-once
generation) = READY, US3 (email delivery) = BLOCKED_BY_G6**. The delivery slice stays gated per
spec 009's verdict — still `EMAIL_DELIVERY_BLOCKED` (re-checked 2026-10-03; unblock conditions
recorded in tasks.md Phase 4). US1/US2 proceeded email-free exactly as this status line allowed;
US3 lands additively once the verdict flips to `EMAIL_DELIVERY_READY`. **Do not mark the full
scheduled-email feature READY before US3 lands.**

**Input**: User description: "Wave 3 (per docs/speckit-implementation-plan.md §3): package 012 — scheduled reports (PR16 · D2b), conditional on 009. `report_schedules` + `report_schedule_runs` tables; weekly/monthly MVP cadence; idempotent ledger per §2.4 (`UNIQUE(scheduleId, scheduledFor)`, hash-only share references — never raw `shareToken`, G7); existing cron infrastructure only (15-minute Cloudflare cron, `src/server.ts scheduled()`); cron re-entry never double-generates or double-sends; boundary test `intelligence-boundaries.test.ts` allowlist updated in the same PR. Implements PR16 (D2b). Needs 005 (reports/shares immutable snapshots, P31/P32) as the report-generation base. Delivery prerequisites recorded by 009 (Loops idempotency keys, failure classification, log hygiene) are consumed here, not re-spiked."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Subscribe a project's report to a weekly or monthly schedule (Priority: P1)

A project owner, viewing a report they trust, chooses "Schedule email delivery", picks a cadence
(weekly or monthly — the MVP set), and supplies recipient email addresses. The schedule is saved
project-scoped, editable (cadence, recipients, pause/resume), and the owner sees honest state at
all times: when the next run is due, when the last run happened, and whether it succeeded, failed,
or was skipped. A schedule that references an existing share link stores only the share's
identifier — the raw share token is never persisted anywhere in schedule data (Constitution P32/G7).

**Why this priority**: without the ability to create and manage schedules there is nothing to
generate or deliver; this slice also carries the two new tables and the boundary-test change, so
every later story depends on it.

**Independent Test**: Can be fully tested by creating/editing/pausing a schedule through the
management surface and asserting persistence, scoping, and the unique-run constraint
(`UNIQUE(scheduleId, scheduledFor)`) — with the cron executor, report generation, and email
sending all stubbed.

**Acceptance Scenarios**:

1. **Given** a project with at least one previously generated report, **When** the owner creates a
   schedule with weekly cadence and two recipients, **Then** the schedule persists with its
   cadence, recipients, project scope, and next-due derivation, and appears in the schedule list
   with its state.
2. **Given** an existing schedule, **When** the owner edits cadence, recipients, or pauses it,
   **Then** the schedule updates without losing run history; a paused schedule produces no new
   runs while paused.
3. **Given** the boundary test that today asserts `report_schedules` must not exist
   (`intelligence-boundaries.test.ts`), **When** this feature lands, **Then** the allowlist is
   updated in the same change so the guard now pins the new tables' allowed locations instead of
   banning their existence (docs plan §2.4).
4. **Given** schedule data at rest, **When** inspected, **Then** no raw share token is stored —
   only hashed or identifier references (G7), and recipient addresses are stored only where the
   delivery product requires them (the schedule's recipient list).

---

### User Story 2 - Scheduled runs generate immutable report snapshots exactly once per due date (Priority: P2)

When the scheduled moment arrives, the system generates the report content once and freezes it as
an immutable snapshot with provenance and branding (Constitution P31) — the same properties a
manually generated report has. Cron re-entry, retries, or overlapping invocations can never
generate or deliver the same scheduled report twice: a durable run ledger keyed by the schedule
and the scheduled-for date guarantees exactly-once semantics per due date (P33). If generation
fails, the run records its failure honestly; a later re-invocation may retry a failed run without
ever duplicating a succeeded one.

**Why this priority**: this is the correctness heart of the feature — the "cron re-entry never
double-generates" acceptance from the plan — and it can be fully verified without any email
infrastructure (which is what G6 still gates).

**Independent Test**: Can be fully tested by invoking the scheduler entry point twice (or
concurrently) for the same due date against seeded schedules and asserting exactly one report
snapshot and one ledger row per `(schedule, scheduledFor)`, plus failed-run retry behavior — with
email delivery disabled.

**Acceptance Scenarios**:

1. **Given** a schedule due on a given date and the scheduler invoked twice for that date (cron
   re-entry), **When** both invocations process it, **Then** exactly one run ledger row and one
   generated report exist for that `(scheduleId, scheduledFor)`.
2. **Given** a failed generation run, **When** the scheduler processes the due schedule again,
   **Then** the failed run may be retried and, on success, still yields exactly one report for
   that due date.
3. **Given** a generated scheduled report, **When** viewed later, **Then** it is an immutable
   snapshot (frozen payload, provenance, branding, consistency state) that never recalculates
   from live data (P31).
4. **Given** no previously generated report exists and a schedule comes due, **When** the run
   executes, **Then** generation happens from stored data only and the outcome (success, failure,
   or skip-with-reason) is recorded in the run ledger.

---

### User Story 3 - Delivered emails arrive once per run, with honest failure states (Priority: P3)

When a scheduled run's report has been generated, the system sends the delivery email to each
recipient. Sends are idempotent at the provider boundary (an idempotency key derived from the run
identity — the capability spec 009 confirmed the provider supports), failures are classified
(transient vs permanent) with bounded retry for transient classes, and run state reflects reality:
`delivered`, `partially delivered`, `failed`, or `skipped` with a reason — never a silent no-op
that looks sent. Missing delivery credentials fail closed with an explicit error, never a
pretend-send (mirroring the degradation honesty 009 observed in the existing auth-email paths).
Recipient addresses never appear in failure logs.

**Why this priority**: delivery is the user-visible payoff, but it is the slice most dependent on
the G6 gate — every delivery-facing requirement below the provider boundary inherits 009's
not-verified findings, so this story lands last and only when READY.

**Independent Test**: Can be fully tested with the provider mocked: one send per recipient per
run (idempotency key stable across retries), transient-failure retry bounded, permanent-failure
classification, credential-absence failing closed, and run-state transitions — plus the
recipient-address log-hygiene check.

**Acceptance Scenarios**:

1. **Given** a succeeded run whose send attempt was interrupted after the provider accepted it,
   **When** the run re-executes its send step, **Then** the same idempotency key is presented and
   no duplicate email results.
2. **Given** a throttling (transient) provider response, **When** the send step runs, **Then** a
   bounded retry occurs and the run state reflects the eventual outcome.
3. **Given** a permanent provider failure (bad credentials, unknown template), **When** the send
   step runs, **Then** the run records failure with the classification — no unbounded retry, no
   false "sent" state.
4. **Given** delivery credentials are absent, **When** a run reaches the send step, **Then** the
   run fails closed with an explicit missing-configuration error (never a silent skip recorded as
   delivered).
5. **Given** any send failure, **When** logs are written, **Then** recipient email addresses do
   not appear in failure output (log hygiene per 009).

---

### Edge Cases

- **Cron overlap**: two 15-minute cron invocations racing — resolved by the unique
  `(scheduleId, scheduledFor)` ledger row; the loser observes the winner's row and skips.
- **Paused/archived schedule at due time**: no run is created; the due date passes without a
  ledger row (pause is a user action, not a failure).
- **Deleted project (cascade)**: schedules belong to the project and disappear with it; run
  history follows the same lifecycle without orphaned delivery attempts.
- **Duplicate recipients across a schedule's list**: deduplicated at creation/edit so one email
  goes to one address per run.
- **Timezone and cadence boundaries**: "monthly" derives the scheduled-for date deterministically
  from the schedule's own cadence rule (e.g. first day of the month); late cron invocations
  target the already-passed due date, never silently skip to the next one — a late run is still
  that date's run.
- **Delivery provider down at send time**: the run stays `partially delivered`/`failed` honestly;
  it never flips to delivered on a retry that was actually a duplicate.
- **No report-generatable data**: a due schedule for a project with no data still runs, generates
  from stored state (including honest empty sections), and delivers — empty data is not a
  failure state (P21/P30 semantics carry over).
- **Re-verification drift**: if delivery credentials are revoked between runs, the next run fails
  closed per credential-absence semantics — recorded, not swallowed.

## Requirements _(mandatory)_

### Functional Requirements

**Schedules & management (US1)**

- **FR-001**: System MUST provide project-scoped report schedules with a weekly or monthly
  cadence (MVP set), a recipient email list, and an active/paused state, editable through the
  project's report management surface.
- **FR-002**: System MUST store schedules in a durable, project-scoped structure with
  organization/user scoping consistent with existing report structures, and MUST enforce a
  durable run ledger with `UNIQUE(scheduleId, scheduledFor)` so one due date admits exactly one
  run (P33).
- **FR-003**: Schedule data MUST NOT persist raw share tokens (P32/G7); references to shared
  reports are stored as identifiers/hashes only.
- **FR-004**: The structural boundary test that currently bans `report_schedules` MUST be updated
  in the same change to allow and pin the new structures' permitted locations (plan §2.4) — the
  structural lock flips from "must not exist" to "must exist only where allowed".
- **FR-005**: System MUST render schedule management honestly: next-due derivation, last-run
  state (succeeded/failed/skipped with reason), and paused state are always visible and never
  inferred.

**Generation idempotency (US2)**

- **FR-006**: Scheduled report generation MUST produce immutable snapshots per P31 (frozen
  payload, provenance, branding snapshot, consistency state) — identical in guarantee to manual
  generation.
- **FR-007**: Cron re-entry, concurrent invocation, or retry MUST NOT generate or enqueue a second
  report for the same `(scheduleId, scheduledFor)`; enforcement is ledger-first (claim-before-do).
- **FR-008**: Failed runs MUST be retryable without ever duplicating a succeeded run for the
  same due date.
- **FR-009**: The scheduler MUST integrate exclusively with the existing scheduled-execution
  infrastructure (the 15-minute cron entry point) — no new cron mechanism, queue, or third
  scheduler (Constitution P37/P50).
- **FR-010**: Generation MUST read stored data only — no render-time paid provider calls (G10);
  a run for a data-less project generates honest empty sections rather than failing (P21).

**Delivery (US3 — gated on 009 = READY)**

- **FR-011**: Delivery MUST supply an idempotency key derived from the run identity
  (`(scheduleId, scheduledFor)`-derived) on every send, so provider-side retries or re-executions
  cannot deliver duplicates.
- **FR-012**: Delivery failures MUST be classified (transient vs permanent) with bounded retry
  for transient classes; classification vocabulary is fixed and covered by tests.
- **FR-013**: Missing delivery credentials or configuration MUST fail closed with an explicit
  error recorded in the run — never a silent skip presented as delivered (the degradation honesty
  009 verified in existing paths).
- **FR-014**: Run delivery state MUST be one of: `delivered`, `partially delivered`, `failed`, or
  `skipped` (with reason) — and MUST be derived deterministically from per-recipient outcomes.
- **FR-015**: Recipient email addresses MUST NOT appear in failure logs or operational output.

**Cross-cutting**

- **FR-016**: Every management operation MUST enforce project-context authorization consistent
  with existing report server functions; cron execution operates with system scope and writes
  audit/trace entries consistent with existing scheduled jobs (P38–P39, P41–P42).
- **FR-017**: The feature MUST record its readiness gate: implementation tasks carry a
  gate-check task verifying 009's verdict is `EMAIL_DELIVERY_READY` before any delivery-path code
  is written; if BLOCKED persists, only US1/US2 (no email) may proceed to implementation.

### Key Entities

- **Report Schedule**: a project-scoped subscription — cadence (weekly/monthly), recipient list,
  active/paused state, optional reference to an existing report share (identifier/hash only);
  derives its next scheduled-for date deterministically from its cadence rule.
- **Schedule Run (ledger row)**: the exactly-once record for one schedule on one scheduled-for
  date — state machine: `claimed → generating → delivering → delivered | partially_delivered |
  failed | skipped`; carries failure classification and per-recipient outcome summary; durable,
  unique on `(scheduleId, scheduledFor)`.
- **Scheduled Report**: an immutable report snapshot (existing entity per P31) produced by a
  schedule run; linked from its ledger row for provenance.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Under forced double-invocation (sequential and concurrent) of the scheduler for the
  same due date, exactly one report and one ledger row exist per `(scheduleId, scheduledFor)`
  across 100% of test fixtures — zero duplicates.
- **SC-002**: 100% of failed runs are retryable to success without producing a duplicate report
  or duplicate delivery for their due date.
- **SC-003**: All cadence derivations (weekly, monthly, month/year boundaries, late cron) resolve
  the correct scheduled-for date in every fixture case — no skipped or doubled due dates across
  a simulated 3-month span.
- **SC-004**: Every schedule management action (create/edit/pause/resume/delete) completes in
  under 5 seconds and reflects its state truthfully on the next view (no stale next-due or
  last-run display).
- **SC-005**: With the delivery provider mocked, 100% of runs produce a correct terminal state
  (`delivered` / `partially delivered` / `failed` / `skipped`) matching the mocked per-recipient
  outcomes, and duplicate-send attempts present identical idempotency keys.
- **SC-006**: A recipient receives at most one email per schedule per due date even under
  re-execution — verifiable with the provider mocked by counting send calls with distinct
  idempotency keys.
- **SC-007**: Zero raw share tokens and zero recipient email addresses appear in schedule rows
  (beyond the recipient list the product requires), logs, or audit output — verified by
  fixture-driven leak audits.

## Assumptions

- **Gating semantics**: "conditional on 009" means implementation waits for
  `EMAIL_DELIVERY_READY`; specification, planning, and task breakdown proceed now (the plan's
  own execution model, §5: "012 stays Draft until 009 = READY"). The gate check is FR-017.
- **Existing cron is the only executor**: the 15-minute Cloudflare scheduled handler
  (`src/server.ts`) remains the sole invocation mechanism; this package adds a due-schedules
  pass to it, not a new scheduler (P37).
- **Report generation reuse**: generation reuses the existing immutable report machinery (005
  hardening: frozen payloads, shares with hash-only tokens, events, branding) — this package
  schedules generation, it does not fork it (P31/P32 inherited, not reimplemented).
- **Delivery provider**: Loops transactional email, per 009's spike focus; the idempotency-key,
  failure-classification, and log-hygiene requirements encode 009's recorded prerequisites
  rather than re-verifying them here.
- **Recipients are user-supplied emails** on the schedule (MVP); org-member directory pickers or
  per-client branding preferences are out of scope for this package.
- **MVP cadences only**: weekly and monthly (per the plan's D2b scope); daily/quarterly/custom
  crontab cadences are out of scope.
- **Timezone policy**: cadence derivation runs in UTC (consistent with existing cron semantics);
  per-timezone scheduling is out of scope for MVP.
- **Schema delivery**: the two new tables land as additive migrations with D1+PG parity per
  project law (P3–P5); no existing report/share tables are reshaped.
- **No PDF attachments in MVP**: 009 noted provider attachments require per-account enablement;
  MVP sends the report as an email with a link (share reference), and attachments are deferred
  until that enablement is confirmed.