---
description: "Task list for spec 012 — Scheduled Reports (weekly/monthly email delivery)"
---

# Tasks: Scheduled Reports (weekly/monthly email delivery)

**Input**: Design documents from `/specs/012-scheduled-reports/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: This repository is constitutionally TDD (P43/P45 — unit/repository/service/UI/E2E mandatory
categories). Test tasks are included and MUST be written first (failing) before the paired
implementation task in the same phase.

**G6 GATE**: US3 (delivery) tasks are **hard-gated** — T026 is a mandatory verdict check that must
pass (009 = `EMAIL_DELIVERY_READY`) before T027+ may run. US1/US2 are implementable now, email-free.
The gate is re-checked at the US3 checkpoint; if BLOCKED persists, US3 tasks stay pending.

**GATE OUTCOME (2026-10-03)**: T026 executed twice (specify-time and implement-time) — verdict
still `EMAIL_DELIVERY_BLOCKED`; maintainer confirmed **stop at the gate**. Final status for this
package: **US1 = READY · US2 = READY · US3 = BLOCKED_BY_G6 (`BLOCKED_BY_EMAIL_DELIVERY_INFRASTRUCTURE`)
· EMAIL_DELIVERY = BLOCKED**. T027–T030 remain `[ ]` pending with the exact unblock conditions
recorded at the Phase 4 gate check. Do not implement US3 with provider-mocked production code.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are relative to repository root

## Path Conventions

- DB schemas: `src/db/` (D1) + `src/db/pg/` (PG mirror); migrations `drizzle/` + `drizzle-pg/`
- Reports feature: `src/server/features/reports/{repositories,services}/`
- Cron pass: `src/server.ts` (existing 15-minute `scheduled()` handler — sole executor, P37)
- Server functions: `src/serverFunctions/reports.ts`
- UI: `src/client/features/reports/`
- E2E: `e2e/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The two new tables with D1+PG parity, shared vocabulary, and the §2.4 boundary-lock
flip — everything every story consumes.

### Tests for Setup (write FIRST, must FAIL)

- [X] T001 [P] Add failing parity expectations in `src/db/schema-parity.test.ts` for the two new
  tables: `report_schedules` (columns per data-model.md §1: `id` PK, `project_id` FK cascade,
  `organization_id`, `report_type`, `cadence`, `recipients`, `share_id` nullable, `active`,
  `paused_at` nullable, `next_due_at`, `last_run_at` nullable, `created_by_user_id` nullable,
  timestamps; indexes `report_schedules_project_idx (project_id)` and
  `report_schedules_due_idx (active, next_due_at)`) and `report_schedule_runs` (columns per
  data-model.md §2: `id` PK, `schedule_id` FK cascade, `scheduled_for`, `report_id` nullable FK,
  `state`, `failure_class` nullable, `skip_reason` nullable, `recipient_outcomes` nullable,
  `claimed_at`, `completed_at` nullable, timestamps; **`uniqueIndex` on
  `(schedule_id, scheduled_for)`** — verbatim P33 constraint)
- [X] T002 [P] Create `src/db/reportsSchedulesMigration.test.ts` (failing) asserting: additive
  migration files exist for both dialects, create tables only (no ALTER on existing tables), and
  the unique index + due index are present in the generated SQL — following the patterns of
  `src/db/ga4Migration.test.ts`
- [X] T003 [P] Add failing locked-token flip expectations in
  `src/server/features/intelligence/intelligence-boundaries.test.ts` per
  contracts/boundary-lock.md: `report_schedules` removed from `LOCKED_TOKENS` (line ~74; other
  three tokens stay), file-head comment narrates the flip ("pinned below" not "does not exist"),
  and a NEW pinned-location check asserting the schedule-table identifiers (`reportSchedules`,
  `reportScheduleRuns`, `report_schedules`, `report_schedule_runs`) are referenced ONLY from the
  allowlist of files named in contracts/boundary-lock.md §3 — including a fixture that fails
  when an out-of-list file references them

### Implementation for Setup

- [X] T004 Add `reportSchedules` + `reportScheduleRuns` tables to `src/db/reports.schema.ts` and
  the PG mirrors to `src/db/pg/reports.schema.ts` exactly per data-model.md §1–2 (constraints
  quoted in T001; `recipients` is a JSON text column; booleans as integer-boolean on D1 per house
  convention); export both from `src/db/schema.ts` + `src/db/pg/schema.ts`; generate additive
  migrations for both dialects (`pnpm run db:generate:d1`, `pnpm run db:generate:pg` — verify
  CREATE-only SQL)
- [X] T005 Add the shared vocabulary in `src/shared/reports.ts`: `REPORT_SCHEDULE_CADENCES =
  ["weekly", "monthly"] as const` + `reportScheduleCadenceSchema`, and `REPORT_SCHEDULE_RUN_STATES`
  = `claimed | generating | delivering | delivered | partially_delivered | failed | skipped` +
  `reportScheduleRunStateSchema`, plus `REPORT_SCHEDULE_FAILURE_CLASSES = generation |
  transient_send | permanent_send | missing_configuration`
- [X] T006 Execute the boundary-lock flip per contracts/boundary-lock.md: remove
  `report_schedules` from `LOCKED_TOKENS` in
  `src/server/features/intelligence/intelligence-boundaries.test.ts`, update the file-head
  narrative, add the new files to the swept surface list, and implement the pinned-location
  check (T003 turns green); confirm the remaining three locked tokens still hold

**Checkpoint**: T001–T003 fail→pass via T004–T006; parity + migration + boundary suites green.
Story phases may start.

---

## Phase 2: User Story 1 — Schedule a report weekly/monthly (Priority: P1) 🎯 MVP

**Goal**: Project-scoped schedule CRUD with honest management UI; pause/resume; the recipient
list validated; no raw share tokens anywhere.

**Independent Test**: Run the US1 suites (V1 in quickstart.md) plus the E2E spec —
create/edit/pause/resume/list all persist with derived `nextDueAt` and truthful last-run
display, with the cron executor, generation, and email entirely stubbed (Vitest mocks) or absent.

### Tests for User Story 1 (write FIRST, must FAIL)

- [X] T007 [P] [US1] Create `src/server/features/reports/services/ReportScheduleService.test.ts`
  covering contracts/schedules-api.md: create derives `nextDueAt` from cadence; recipients
  validated (non-empty, email-shaped, server-side dedupe + lowercase, count ≤ 10 — verbatim
  data-model §1 rules); `shareId` when present must resolve to a share of a report in the same
  project (else `VALIDATION_ERROR`); `reportType` restricted to frozen `REPORT_TYPES`; pause sets
  `active=false` + `pausedAt` and leaves `nextDueAt` frozen; resume re-derives `nextDueAt` from
  the resume moment; list returns schedules + latest-run summary (state, completedAt,
  scheduledFor) with `not yet run` when no run exists
- [X] T008 [P] [US1] Create `src/serverFunctions/reports.schedules.authorization.test.ts`
  (mirroring the existing `*.authorization.test.ts` pattern): wrong-project schedule access,
  unauthenticated access, and cross-org leakage are all rejected for each of the five functions
- [X] T009 [P] [US1] Create `e2e/report-schedules.spec.ts` (Playwright, per quickstart V4):
  create via modal (cadence + recipients), list shows next-due + last-run state chip; pause →
  resume reflects truthfully on next view; zero-schedules shows setup guidance distinct from the
  error state; the modal never displays a raw share token (links an existing share by pick list)

### Implementation for User Story 1

- [X] T010 [US1] Implement `src/server/features/reports/repositories/ReportScheduleRepository.ts`
  (persistence only): insert/update/pause/resume/list-by-project + latest-run-per-schedule join;
  no raw-token columns ever touched
- [X] T011 [US1] Implement `src/server/features/reports/services/ReportScheduleService.ts` per
  contracts/schedules-api.md (validation rules quoted in T007); `cadence.ts` dependency allowed
  via a minimal `deriveNextDueAt(cadence)` stub returning next Monday/1st (full derivation lands
  with US2's cadence task T017 — keep this stub honest and marked)
- [X] T012 [P] [US1] Add Zod schemas in `src/types/schemas/reports.ts`: `createReportScheduleSchema`,
  `updateReportScheduleSchema`, `pauseReportScheduleSchema`, `resumeReportScheduleSchema`,
  `listReportSchedulesSchema` — trust boundaries per contracts/schedules-api.md validation rules
- [X] T013 [US1] Add the five server functions to `src/serverFunctions/reports.ts`
  (`createReportSchedule`, `updateReportSchedule`, `pauseReportSchedule`, `resumeReportSchedule`,
  `listReportSchedules`) on the existing `requireProjectContext` middleware, same shape as the
  neighboring report fns
- [X] T014 [P] [US1] Create `src/client/features/reports/ScheduleEmailModal.tsx`: create/edit form
  (report type from frozen labels, cadence radio, recipients input with client-side dedupe hints,
  share pick-list); never renders raw tokens
- [X] T015 [P] [US1] Create `src/client/features/reports/ReportSchedulesPanel.tsx`: schedule list
  with cadence label, recipient count (click to reveal), `nextDueAt` display, last-run state chip
  (succeeded / partially delivered / failed / skipped / not yet run), pause/resume affordances;
  loading / ready / empty (setup guidance) / error states per the honest-state vocabulary
- [X] T016 [US1] Mount the panel in `src/client/features/reports/ReportsPage.tsx` and wire the
  query/mutation hooks (TanStack Query conventions per house style); T009 turns green

**Checkpoint**: quickstart V1 + V4 green; US1 independently demoable (schedules exist, are
manageable, and persist — no cron needed yet).

---

## Phase 3: User Story 2 — Exactly-once generation per due date (Priority: P2)

**Goal**: The 15-minute cron pass claims due schedules, generates immutable reports once per
`(scheduleId, scheduledFor)`, records honest run states, and advances due dates — cron re-entry
can never double-generate.

**Independent Test**: Run the US2 suites (quickstart V3) with email absent: double-invocation
(sequential + concurrent) produces exactly one report + one ledger row; failed runs retry on the
same row; paused schedules produce no rows; cadence fixtures over a simulated 3-month span derive
correct keys.

### Tests for User Story 2 (write FIRST, must FAIL)

- [X] T017 [P] [US2] Create `src/server/features/reports/services/cadence.test.ts` covering
  research.md R2 + data-model.md §4: weekly `scheduledFor` = due week's Monday (`YYYY-MM-DD`),
  monthly = `YYYY-MM-01`; `nextDueAt` = next Monday / 1st of next month 00:00 UTC; late runs
  target the passed due date; missed-multi-period → one catch-up then advance; paused span
  re-derivation on resume; a simulated 3-month span fixture asserts no skipped/doubled due
  dates (SC-003)
- [X] T018 [P] [US2] Create `src/server/features/reports/services/ScheduleRunService.test.ts`
  covering contracts/schedule-runs.md claim semantics (research R1): insert-as-claim succeeds on
  first call; unique-violation catch reads the existing row and returns
  `already-terminal` (no-op) / `fresh-conflict` (skip) / `stale-conflict` (reclaim, window 1h);
  failed→retry transitions the SAME row back to `claimed` (constraint forbids a second row);
  state transitions refuse invalid paths (e.g. `delivered → anything`)
- [X] T019 [P] [US2] Create `src/server/features/reports/services/scheduledReportRuns.test.ts`
  (cron pass, per contracts/schedule-runs.md): sequential double-invocation → exactly one
  `ReportService.generateReport` call + one row (SC-001); concurrent double-invocation → same
  (mock the repository claim with a unique-violation on the second); failed generation →
  `failed (generation)` + retry path succeeds without duplicates (SC-002); paused-at-due → no
  row; zero-data project → honest-empty snapshot generated (P21) and the run completes;
  `nextDueAt` advances after each run; per-schedule try/catch keeps one failure from aborting the
  pass (mirrors `scheduledGa4Sync` logging shape with `[cron:reports]` prefix)

### Implementation for User Story 2

- [X] T020 [US2] Implement `src/server/features/reports/services/cadence.ts` (pure): period-key
  derivation, `nextDueAt` derivation, one-catch-up-then-advance logic — per T017 fixtures;
  replace the T011 stub's marked usage with the real module
- [X] T021 [US2] Implement `src/server/features/reports/services/ScheduleRunService.ts`: the
  ledger state machine per data-model.md §2 + contracts/schedule-runs.md — insert-as-claim with
  unique-catch, stale-claim reclaim (STALE_CLAIM_WINDOW = 1h), same-row failed retry, terminal
  no-op; `recipient_outcomes` left null in this story (delivery lands in US3)
- [X] T022 [US2] Implement `src/server/features/reports/services/scheduledReportRuns.ts` (the
  cron pass) per contracts/schedule-runs.md: due query via the due index, per-schedule try/catch,
  claim → `ReportService.generateReport` (UNTOUCHED call — its P31 provenance is inherited) →
  rest in `delivering` (report linked, awaiting the US3 send step — no placeholder transitions,
  no fake terminal states) + `nextDueAt` advance; generation failure records
  `failed (generation)` and skips delivery entirely
- [X] T023 [US2] Register the pass in `src/server.ts` `scheduled()`: add
  `await runScheduledReportRuns()` inside the existing `withPgClient` block after
  `runScheduledIntelligenceScan()` — one line + import; no other handler changes (P37)
- [X] T024 [US2] Add trace/telemetry per contracts/schedule-runs.md: `[cron:reports]` console
  prefix; `report:schedule_run` telemetry event with ids only (no recipient data, P41–P42 —
  ledger authoritative)

**Checkpoint**: quickstart V3 green; US2 demoable: due schedules generate exactly-once under
forced re-entry, runs visible in the US1 panel's last-run chip.

---

## Phase 4: User Story 3 — Delivered once, honestly (Priority: P3) — **G6-GATED**

**Goal**: Per-recipient sends with provider idempotency, classified failures with bounded retry,
fail-closed credentials, scrubbed logs, and deterministic delivery states.

**Independent Test**: quickstart V5 with the provider mocked: identical keys across retries,
transient retry bounded at 2, permanent no-retry, missing-config fail-closed, run states derived
from per-recipient outcomes, recipient addresses absent from logs + stored outcomes.

### Gate Check (MANDATORY before US3 implementation tasks)

- [X] T026 Verify spec 009's verdict is `EMAIL_DELIVERY_READY` in
  `specs/009-email-delivery-spike/verdict.md`; if it reads `EMAIL_DELIVERY_BLOCKED`, STOP — leave
  T027+ pending and report the gate status. If READY, also confirm the unblock prerequisites
  are recorded (Loops credentials + `LOOPS_TRANSACTIONAL_SCHEDULED_REPORT_ID` template owned and
  published) before proceeding.

> **GATE STATUS (re-checked 2026-10-03): `EMAIL_DELIVERY_BLOCKED` — T027–T030 pending.**
> Reason: `BLOCKED_BY_EMAIL_DELIVERY_INFRASTRUCTURE`. Maintainer decision recorded this
> session: do NOT implement the live send step, do NOT waive G6 with provider-mocked
> production code. All already-shipped work stays preserved: schedule model, run ledger,
> idempotent logical run identity, generation flow, share-creation flow, failure-safe
> schedule state.
>
> **Exact unblock conditions** (all required, then US3 proceeds additively per its contracts):
> 1. `LOOPS_API_KEY` provisioned for this deployment.
> 2. An owned scheduled-report transactional template exists (with the report data variables),
>    recorded as `LOOPS_TRANSACTIONAL_SCHEDULED_REPORT_ID`.
> 3. The template is verified published/usable against the live account.
> 4. The 009 credentialed readiness re-run flips the recorded verdict from
>    `EMAIL_DELIVERY_BLOCKED` to `EMAIL_DELIVERY_READY` in
>    `specs/009-email-delivery-spike/verdict.md`.
>
> Once READY, US3 delivers: Loops send step with `Idempotency-Key` from the run identity,
> transient/permanent failure classification with bounded retry, fail-closed missing-config
> behavior, live-send verification, and no duplicate delivery on retry/re-entry.
> **Do not mark the full scheduled-email feature READY before US3 lands.**
>
> Allowed status: US1 = READY · US2 = READY · US3 = BLOCKED_BY_G6 · EMAIL_DELIVERY = BLOCKED.
> This is the intended hard-gate behavior, not an implementation failure.

### Tests for User Story 3 (write FIRST, must FAIL — only after T026 passes)

- [ ] T027 [P] [US3] Create `src/server/features/reports/services/scheduledReportEmail.test.ts`
  (provider mocked) per contracts/schedule-runs.md §delivery: idempotency key =
  `sha256(scheduleId | scheduledFor | recipient)` and stays identical across retries of the
  same (run, recipient) (SC-006); 429/5xx/network → transient with exactly 2 retries then
  `transient_send`; 400/404/401/403/409-mismatch → permanent, no retry, `permanent_send`;
  missing `LOOPS_API_KEY` or `LOOPS_TRANSACTIONAL_SCHEDULED_REPORT_ID` → fail-closed BEFORE any
  request, `missing_configuration` (never a silent skip); run delivery state derived:
  all-sent → `delivered`, some → `partially_delivered`, none → `failed`;
  `skipped` recorded with reason (`paused_before_send`, `no_recipients_after_validation`)
  distinct from failure; log/output leak audit — recipient addresses appear NOWHERE in logs and
  `recipient_outcomes` stores hashes only (SC-007)

### Implementation for User Story 3

- [ ] T028 [US3] Implement `src/server/features/reports/services/scheduledReportEmail.ts` per
  research.md R4 + contracts/schedule-runs.md: its own Loops HTTP call with `Idempotency-Key`
  header (env: `LOOPS_API_KEY`, `LOOPS_TRANSACTIONAL_SCHEDULED_REPORT_ID` — fail-closed reads),
  transient/permanent classification with bounded retry (2/recipient/run), scrubbed logging
  (status/classification/key-hash only), link-based payload (no attachments — 009 enablement
  pending). `src/server/email/loops.ts` stays UNTOUCHED (auth paths frozen)
- [ ] T029 [US3] Wire delivery into `ScheduleRunService`/`scheduledReportRuns.ts`: implement the
  real send step for runs resting in `delivering` — per-recipient sends (deduped
  list), outcome aggregation into `recipient_outcomes` (hashed), terminal state per
  data-model.md §2; paused-between-claim-and-send → `skipped (paused_before_send)` (never
  failure)
- [ ] T030 [US3] Update the US1 panel's last-run chip to surface `partially_delivered` +
  `skipped` honestly (copy distinct from failure) in
  `src/client/features/reports/ReportSchedulesPanel.tsx`; re-run `e2e/report-schedules.spec.ts`
  (extend with a partially-delivered state fixture if the E2E environment supports seeding runs)

**Checkpoint**: quickstart V5 green; end-to-end: a due schedule generates once, delivers once per
recipient, and every failure mode is visible and honest.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T031 [P] Run quickstart V0–V5 validations and record outcomes; confirm V0 gate status is
  documented (READY or BLOCKED) in the run notes
- [X] T032 Run full gates: `pnpm exec tsc --noEmit`, `pnpm exec oxlint --type-aware` on all
  touched files, `pnpm vitest run src/db/schema-parity.test.ts
  src/db/reportsSchedulesMigration.test.ts
  src/server/features/intelligence/intelligence-boundaries.test.ts
  src/server/features/reports src/serverFunctions`; confirm no-regression on
  `ReportService.snapshot.test.ts`, `ShareService.test.ts`, `shareTrustBoundary.test.ts`
  (untouched, green)
- [X] T033 [P] Security sweep (G7/P32 evidence): grep schedule/run code + UI for raw
  `shareToken`/`share_token`/unhashed recipient strings in stored columns, logs, and telemetry;
  extend the T003 pinned-location guard if any drift is found
- [X] T034 [P] Verify `wrangler.jsonc` unchanged (no new triggers — P37) and the cron pass is
  the only execution path (no workflows, queues, or third-party schedulers introduced)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — T001–T003 tests first, then T004–T006; **BLOCKS all
  stories** (tables + vocabulary + lock flip)
- **US1 (Phase 2)**: after Setup — MVP; T010→T011 before T013 (repository → service → fns);
  T014/T015 parallel before T016 wiring
- **US2 (Phase 3)**: after Setup + US1's repository/service (T010/T011) for schedule rows; T020
  (cadence) unblocks T011's stub replacement; T021 → T022 → T023 sequential
- **US3 (Phase 4)**: **hard-gated on T026** (009 = READY); after US2 (claim/delivery states must
  exist to wire into); T028 → T029 → T030
- **Polish (Phase 5)**: after completed stories (T033/T034 can run alongside US3 if it stays
  gated — they cover the shipped slices)

### User Story Dependencies

- **US1 (P1)**: no story dependencies — MVP; uses only Setup output
- **US2 (P2)**: depends on US1's schedule persistence (T010/T011); no email dependency
- **US3 (P3)**: depends on US2's run ledger + state machine AND the G6 gate (T026); explicitly
  skippable without harming US1/US2

### Within Each User Story

- Tests fail first, then paired implementation turns them green (P43)
- Repository → service → server functions → UI wiring (house layering, P1)
- The untouched-frozen invariants (`ReportService.generateReport` signature, `loops.ts` auth
  paths, existing report/share suites) are re-verified at each story checkpoint

### Parallel Opportunities

- Setup tests: T001 ∥ T002 ∥ T003 (distinct files); then T004 → (T005 ∥ T006)
- US1 tests: T007 ∥ T008 ∥ T009; implementation: (T010 ∥ T012) → T011 → T013 → (T014 ∥ T015) → T016
- US2 tests: T017 ∥ T018 ∥ T019 (distinct files); implementation: T020 ∥ T021 → T022 → (T023 ∥ T024)
- US3: T027 single test file; T028 → T029 → T030
- Polish: T031 ∥ T033 ∥ T034 after gates (T032)

## Parallel Example: User Story 1

```text
# Launch US1 test tasks together (all fail first):
Task: "ReportScheduleService.test.ts — CRUD validation + cadence + pause/resume fixtures"
Task: "reports.schedules.authorization.test.ts — project-scope auth matrix"
Task: "e2e/report-schedules.spec.ts — modal, panel states, pause/resume truthfulness"

# Then implementation:
Task: "ReportScheduleRepository.ts (persistence only)"
Task: "Zod schemas in types/schemas/reports.ts"
Task: "ReportScheduleService.ts (validation; cadence stub)"
Task: "Five server functions in serverFunctions/reports.ts"
Task: "ScheduleEmailModal.tsx ∥ ReportSchedulesPanel.tsx"
Task: "Mount panel in ReportsPage.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (T001–T006) — tables + parity + lock flip green
2. Phase 2 (T007–T016) — schedules manageable, honest UI
3. **STOP and VALIDATE**: quickstart V1 + V4; demo CRUD + pause/resume

### Incremental Delivery

1. Setup → US1 (management MVP) → validate
2. US2 (exactly-once generation; cron live) → validate V3
3. T026 gate check → if READY: US3 (delivery) → validate V5; if BLOCKED: ship US1+US2, US3 stays
   pending with the gate re-checked on the next session
4. Polish/gates → merge

### Notes

- The T011 cadence stub is the only deliberate cross-story seam: it keeps US1 testable without
  US2's cadence module and is replaced by T020 (the stub's tests keep passing — derivation
  fixtures in T017 are stricter)
- US2 runs rest in `delivering` (report linked, send step pending) — no placeholder transitions;
  T029 adds the send step that moves them to terminal states, so US2→US3 is purely additive
- Any discovered need beyond the MVP scope (attachments, per-timezone, daily cadence, PDF
  embedding) is OUT — raise to plan gates, never grow the slice silently (P50)