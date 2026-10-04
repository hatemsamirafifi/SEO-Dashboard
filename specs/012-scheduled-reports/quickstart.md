# Quickstart — spec 012 validation guide

Prerequisites: repo deps installed (`pnpm install`); local D1 migrated
(`pnpm run db:migrate:local` after this feature's migrations land). No live email provider is
required for any validation below — the delivery suite runs with the provider mocked; live-send
checks appear only with 009's credentialed re-run.

## V0 — G6 gate check (before any delivery code)

```
# Read the recorded verdict:
type specs\009-email-delivery-spike\verdict.md | findstr VERDICT
```

Expected today: `EMAIL_DELIVERY_BLOCKED` → US1/US2 only. If a credentialed re-run flips it to
`EMAIL_DELIVERY_READY`, the delivery slice (T-block G, per tasks.md) is unblocked.

## V1 — Schedules & management (unit + auth)

```
pnpm vitest run src/server/features/reports/services/ReportScheduleService.test.ts
pnpm vitest run src/serverFunctions/reports.schedules.authorization.test.ts
```

Covers: create/edit/pause/resume/list with cadence + recipient validation (dedupe, ≤10,
lowercase); pause freezes `nextDueAt`, resume re-derives it; share reference validated
project-local; wrong-project/unauthenticated access rejected.

## V2 — Schema parity + boundary lock flip (same-PR evidence)

```
pnpm vitest run src/db/schema-parity.test.ts src/db/reportsSchedulesMigration.test.ts
pnpm vitest run src/server/features/intelligence/intelligence-boundaries.test.ts
```

Covers: `report_schedules`/`report_schedule_runs` D1↔PG parity (columns, FKs,
`UNIQUE(schedule_id, scheduled_for)`, due index); additive-migration safety; locked-token sweep
green with `report_schedules` removed from `LOCKED_TOKENS`; the new pinned-location check passes
and fails when an out-of-list file references the tables (fixture-driven).

## V3 — Exactly-once ledger + cron pass (the D2b heart)

```
pnpm vitest run src/server/features/reports/services/cadence.test.ts
pnpm vitest run src/server/features/reports/services/ScheduleRunService.test.ts
pnpm vitest run src/server/features/reports/services/scheduledReportRuns.test.ts
```

Covers (SC-001/002/003): double-invocation (sequential + concurrent) → exactly one report row +
one ledger row per `(scheduleId, scheduledFor)`; unique-violation catch → skip; stale-claim
reclaim within window; failed→retry→success reuses the same row; paused-at-due → no row;
cadence fixtures over a simulated 3-month span (week/month boundaries, late runs target the
passed date, missed-multi-period → one catch-up then advance); zero-data project → honest-empty
snapshot delivered (P21).

## V4 — Management UI (component + E2E)

```
pnpm exec playwright test e2e/report-schedules.spec.ts
```

Covers (SC-004): create schedule via modal (cadence + recipients), list shows next-due +
last-run state chip; pause/resume reflects truthfully on next view; empty state shows setup
guidance (distinct from error state).

## V5 — Delivery (GATED — run only after 009 = READY)

```
pnpm vitest run src/server/features/reports/services/scheduledReportEmail.test.ts
```

Covers (SC-005/006/007, provider mocked): stable idempotency keys across send retries;
transient (429/5xx/network) bounded retry; permanent (400/404/401) no-retry; missing config
fails closed as `missing_configuration`; run state derived from per-recipient outcomes
(`delivered`/`partially_delivered`/`failed`); `skipped` with reason distinct from failure;
recipient-address leak audit across logs + `recipient_outcomes` (hashes only).

## Gates (must stay green)

```
pnpm types:check && pnpm oxlint
pnpm vitest run src/db/schema-parity.test.ts
pnpm vitest run src/server/features/intelligence/intelligence-boundaries.test.ts
pnpm exec tsc --noEmit
```

No existing suite may regress: `ReportService.snapshot.test.ts` (P31 untouched),
`ShareService.test.ts`, `shareTrustBoundary.test.ts` all stay green without edits.