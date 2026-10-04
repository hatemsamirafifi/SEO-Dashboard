# Implementation Plan: Scheduled Reports (weekly/monthly email delivery)

**Branch**: `012-scheduled-reports` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-scheduled-reports/spec.md`

## Summary

Deliver wave-3 package 012 (PR16 · D2b) in three coordinated slices, **conditional on spec 009's
gate**: (1) **schedules & management** — project-scoped `report_schedules` with weekly/monthly
cadence, recipient list, active/paused state, CRUD server functions on the existing
`requireProjectContext` middleware, and a management UI on the Reports page; the structural
lock flip in `intelligence-boundaries.test.ts` (`report_schedules` moves from banned token to
pinned-allowlist surface, plan §2.4); (2) **exactly-once generation** — `report_schedule_runs`
ledger with `UNIQUE(scheduleId, scheduledFor)`, a `scheduledReportRuns` pass added to the
existing 15-minute cron entry (`src/server.ts scheduled()` — the sole executor, P37), claim-before-
do semantics so cron re-entry can never double-generate, and failed-run retry that can never
duplicate a succeeded run; generation reuses `ReportService.generateReport` unchanged (P31
snapshots inherited, not forked); (3) **delivery** (gated: lands only when 009 =
`EMAIL_DELIVERY_READY`) — per-recipient Loops sends with `Idempotency-Key` derived from the run
identity, transient/permanent classification with bounded retry, fail-closed credential
semantics, recipient-address log hygiene, and deterministic run delivery states.

**Gate handling (G6) is structural**: the tasks file carries a verdict-check task before any
delivery code; US1/US2 are implementable email-free the moment this plan is approved.

Key grounding facts discovered during planning (they shape the design):

- `generateReport` (`src/server/features/reports/services/ReportService.ts:171`) already produces
  fully-provenanced immutable snapshots (dual-sided consistency, branding freeze, `created`
  event, telemetry) — the scheduler calls it; it is never re-implemented. Its `userId` is
  optional and `domain` is nullable: cron-scope generation needs no user context.
- The existing cron handler (`src/server.ts:187`) runs four passes per 15-minute tick inside
  `withPgClient`; `runScheduledGa4Sync` (`scheduledGa4Sync.ts`) is the established
  due-processing pattern (list → guard → per-item try/catch with honest skip logging) — the new
  pass follows it exactly.
- `intelligence-boundaries.test.ts:74` pins `report_schedules` as a **LOCKED_TOKEN** over a fixed
  file surface (lines 380–442) — the D2b change removes the token from that list and adds the
  new files to the allowed surface so the guard pins permitted locations instead (§2.4).
- `sendLoopsTransactionalEmail` (`src/server/email/loops.ts:38`) currently sends **no**
  idempotency key and logs recipient addresses on failure (`loops.ts:68-73`) — both are 009
  prerequisites that land here: a schedule-aware sender wraps the Loops call with an
  `Idempotency-Key` header and scrubbed logging; the auth-email paths are left untouched.
- `ShareService.createReportShare` returns a one-time raw token; schedules reference shares by
  id/hash only — `report_shares.id` + `tokenHash` already suffice for a link payload (P32/G7
  needs no new share machinery).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), React 19, Node 24 / Cloudflare Workers runtime

**Primary Dependencies**: TanStack Start (server functions + `requireProjectContext`
middleware), Drizzle ORM 0.45 (SQLite/D1 + PostgreSQL dual schemas, additive migrations + parity
tests), Zod 4 (trust-boundary validation), existing `ReportService` / `ShareService` /
`SharingRepository` (005 machinery), Loops transactional API (delivery, gated), Vitest 3 +
Playwright

**Storage**: two new tables in `src/db/reports.schema.ts` + `src/db/pg/reports.schema.ts`
(additive, D1+PG parity, project-scoped FKs — P3–P5):
- `report_schedules`: `id`, `projectId` (FK cascade), `organizationId`, `reportType`, `cadence`
  (`weekly`|`monthly`), `recipients` (JSON array, deduped), `active`, `pausedAt`, `shareId`
  (nullable ref), `nextDueAt`, `lastRunAt`, `createdByUserId`, timestamps; indexes on
  `(projectId)`, `(active, nextDueAt)`
- `report_schedule_runs`: `id`, `scheduleId` (FK), `scheduledFor` (date), `reportId` (nullable
  ref), `state`, `failureClass` (nullable), `recipientOutcomesJson`, `claimedAt`, `completedAt`,
  timestamps; **`UNIQUE(scheduleId, scheduledFor)`** (P33); index on `(scheduleId, scheduledFor)`

**Testing**: Vitest colocated (`*.test.ts`); existing suites extended:
`intelligence-boundaries.test.ts` (lock flip), `schema-parity.test.ts`,
`ReportService.snapshot.test.ts` untouched-green; new suites for repository
(unique-constraint + retry), scheduler (double-invocation, cadence derivation, paused skip),
sender (idempotency key, classification, log hygiene, fail-closed), service auth tests
(`serverFunctions/reports.schedules.authorization.test.ts`); Playwright
`e2e/report-schedules.spec.ts` (management UI; cron logic covered by unit suites).

**Target Platform**: Cloudflare Workers (D1 + PG deployments); the 15-minute cron trigger
(`wrangler.jsonc` — unchanged) is the only executor.

**Project Type**: web-application (TanStack Start full-stack)

**Performance Goals**: cron pass bounded per tick (due-schedules query is
`active + nextDueAt <= now` — indexed); generation cost is one existing `generateReport` call
per due schedule; delivery bounded (≤ a few recipients per schedule, MVP).

**Constraints**: G6 (delivery waits for 009 = READY); P31 (immutable snapshots — inherited);
P32/G7 (no raw share tokens at rest); P33 (idempotent `(scheduleId, scheduledFor)` ledger);
P37 (Cloudflare-native execution, existing cron only); P21 (zero-row success ≠ failure);
P38–P39 (project scoping on every management fn; cron is system-scoped);
P41–P42 (trace entries for schedule ops; run ledger is authoritative — not the trace);
P43–P45 (TDD, `pnpm types:check` + `pnpm oxlint` + parity gates).

**Scale/Scope**: hundreds of schedules per project at most (MVP); weekly/monthly cadences only;
15-minute cron gives ≥4 due-checks per hour (ample for weekly/monthly granularity).

**Open technical decisions** (resolved in [research.md](./research.md)):
- R1: ledger claim semantics — how exactly-once is enforced across concurrent cron invocations
  on both D1 and PG (transactional claim vs unique-catch).
- R2: cadence/`scheduledFor` derivation and late-run semantics (month boundaries, paused spans,
  missed multiple periods).
- R3: how the idempotency key is derived and what the delivery state machine looks like
  (per-recipient outcomes → run state).
- R4: where the schedule-aware sender lives without touching the auth-email paths, and the
  Loops header/failure-classification mapping.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Post-Phase-1 re-check (2026-10-03): PASS.** Design artifacts ([data-model.md](./data-model.md),
[contracts/](./contracts/)) re-verified row-by-row after design: the ledger enforces
`UNIQUE(scheduleId, scheduledFor)` with claim-before-do (P33 confirmed in
contracts/schedule-runs.md); schedules store `shareId`/`tokenHash` references only — raw tokens
never at rest (P32/G7 confirmed in data-model §1 and contracts/schedules-api.md); generation
calls the existing `generateReport` unmodified so P31 is inherited, not reimplemented; the lock
flip replaces the banned token with a pinned allowed-surface list (§2.4 confirmed in
contracts/boundary-lock.md); cron remains the sole executor (P37 — `scheduled()` gains one pass,
nothing else); delivery is gated on 009 with an explicit verdict-check task (G6); fail-closed
credential semantics + log hygiene match the 009-verified degradation pattern. No violations; no
complexity-tracking entries required.

| Gate / Principle | Requirement for this feature | Status |
| --- | --- | --- |
| P1/P2 (layers, no competing architecture) | Server fn → new `ReportScheduleService`/`ScheduleRunService` → new repository; generation reuses `ReportService.generateReport`; no second report generator or scheduler | PASS by design |
| P3–P5 (DB law) | `report_schedules` + `report_schedule_runs` additive on D1+PG, project-scoped FKs, parity + migration tests in same change | PASS — data-model.md |
| P31 (immutable snapshots) | Scheduled reports are ordinary `reports` rows via the existing generator (frozen payload/provenance/branding) | PASS — inherited |
| P32/G7 (hash-only shares) | Schedules reference `shareId` (and hash) — raw token exists only at creation, never in schedule/run data | PASS — contract |
| P33 (idempotent schedules) | Durable ledger + `UNIQUE(scheduleId, scheduledFor)` + claim-before-do; re-entry/retry never double-generates or double-sends | PASS — ledger contract + tests named |
| P37 (Cloudflare-native execution) | One new pass in the existing `scheduled()` handler; no new queues/crons/third-party schedulers | PASS |
| P21 (zero-row ≠ failure) | Data-less projects generate honest-empty reports and deliver them; skipped/paused are distinct from failed | PASS — run states |
| P38–P40 (security) | `requireProjectContext` on every management fn + auth tests; cron system-scoped like existing passes; public share route untouched | PASS |
| P41–P42 (trace/ledgers) | Schedule/run ops write trace entries consistent with existing taxonomy; the run ledger — not the trace — is authoritative | PASS |
| P43–P45 (tests/gates) | TDD; repository/scheduler/sender/service/UI/E2E categories; `pnpm types:check` + `pnpm oxlint` + parity gates | PASS — quickstart.md |
| G6 (delivery verification) | Delivery slice gated on 009 = `EMAIL_DELIVERY_READY`; verdict-check task precedes any delivery code | PASS — structural gate |
| G10 (no render-time paid work) | Generation reads stored data only (existing generator's contract); UI reads stored schedules/runs | PASS |
| P50 (scope discipline) | MVP weekly/monthly only; no attachments (009: provider enablement pending); no per-timezone scheduling; auth-email paths untouched | PASS |

**Violations**: none. No complexity-tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/012-scheduled-reports/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── schedules-api.md     # CRUD server functions + management UI contract
│   ├── schedule-runs.md      # ledger, claim semantics, cron pass, state machine
│   └── boundary-lock.md      # §2.4 lock-flip: banned token → pinned allowlist
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── db/
│   ├── reports.schema.ts              # + reportSchedules, reportScheduleRuns (D1)
│   ├── pg/reports.schema.ts           # + mirrors (PG)
│   ├── schema.ts / pg/schema.ts        # exports
│   ├── schema-parity.test.ts          # extended
│   └── reportsSchedulesMigration.test.ts   # NEW: additive-migration parity
├── server/
│   ├── features/reports/
│   │   ├── repositories/ReportScheduleRepository.ts      # NEW (persistence only)
│   │   ├── services/ReportScheduleService.ts            # NEW (CRUD + validation)
│   │   ├── services/ScheduleRunService.ts               # NEW (claim/generate/deliver orchestration)
│   │   ├── services/scheduledReportRuns.ts              # NEW (cron pass: due → claim → run)
│   │   ├── services/cadence.ts                          # NEW (weekly/monthly derivation)
│   │   ├── services/scheduledReportEmail.ts             # NEW (gated: Loops send + idempotency key
│   │   │                                                #   + classification + scrubbed logging)
│   │   └── services/ReportScheduleService.test.ts | ScheduleRunService.test.ts |
│   │       scheduledReportRuns.test.ts | cadence.test.ts | scheduledReportEmail.test.ts
│   └── email/loops.ts                  # UNCHANGED (auth paths untouched; schedule sender wraps)
├── server.ts                           # scheduled(): + runScheduledReportRuns() pass
├── serverFunctions/
│   └── reports.ts                       # + schedule CRUD fns (create/update/pause/resume/list)
│   └── reports.schedules.authorization.test.ts          # NEW: auth tests
├── types/schemas/reports.ts             # + schedule schemas (Zod, trust boundary)
├── shared/reports.ts                    # + REPORT_SCHEDULE_CADENCES + run-state vocabulary
├── client/features/reports/
│   ├── ReportSchedulesPanel.tsx         # NEW: schedule list + state display
│   ├── ScheduleEmailModal.tsx           # NEW: create/edit (cadence, recipients, share ref)
│   └── ReportsPage.tsx                  # panel mount
└── e2e/
    └── report-schedules.spec.ts         # management UI (cron logic unit-covered)
```

**Structure Decision**: single-project web application (existing monorepo layout). All new code
follows established feature-folder conventions inside the existing `reports` feature — no new
top-level directories. The cron pass lives beside the existing scheduled services
(`scheduledReportRuns.ts` mirrors `scheduledGa4Sync.ts`'s shape); the email sender is a
schedule-scoped service that wraps the provider call, deliberately separate from
`src/server/email/loops.ts` (auth paths stay frozen; 009 observed their semantics and this
package must not drift them).

## Complexity Tracking

> Not applicable — Constitution Check has no violations to justify.