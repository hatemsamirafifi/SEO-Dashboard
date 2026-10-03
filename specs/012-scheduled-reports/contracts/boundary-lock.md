# Contract: Boundary Lock Flip (plan §2.4 — mandatory same-PR change)

## Current state

`src/server/features/intelligence/intelligence-boundaries.test.ts:74` pins
`report_schedules` in `LOCKED_TOKENS`:

```ts
const LOCKED_TOKENS = [
  "rankScore",
  "causedBy",
  "finding_samples",
  "report_schedules",   // ← removed by this feature
];
```

The locked-token sweep (line ~443, `it.each(LOCKED_TOKENS)`) asserts the token string appears
**nowhere** across a fixed file surface (the Stage-1/intelligence + reports + share files
enumerated at lines ~380–442). The comment at the file head still narrates
"no … no report_schedules" among the frozen Stage-1 locks.

## New state (this feature, same PR as the tables)

1. **Token removed from `LOCKED_TOKENS`** (the other three stay frozen forever).
2. **Narrative updated**: the file-head comment and the Stage-1 notes change from
   "no report_schedules exists (structural lock)" to "report_schedules exists (spec 012) and is
   pinned below" — the lock's *purpose* flips from non-existence to location-pinning.
3. **New files join the swept surface** (they now *must not contain* the remaining locked tokens,
   and — via a new dedicated check — the schedule tables are only touched from allowed files).
   The guard file itself
   (`src/server/features/intelligence/intelligence-boundaries.test.ts`) is allowlisted: it
   must name the identifiers to pin them.
   - `src/db/reports.schema.ts`, `src/db/pg/reports.schema.ts` (already swept; now contain the
     tables)
   - the new migrations (D1 + PG)
   - `src/server/features/reports/repositories/ReportScheduleRepository.ts`
   - `src/server/features/reports/services/{ReportScheduleService,ScheduleRunService,
     scheduledReportRuns,cadence,scheduledReportEmail}.ts`
   - `src/serverFunctions/reports.ts` (already swept)
   - `src/types/schemas/reports.ts`, `src/shared/reports.ts` (already swept)
   - `src/client/features/reports/{ReportSchedulesPanel,ScheduleEmailModal,ReportsPage}.tsx`
4. **New pinned-location check** (replaces the non-existence assertion): the schedule-table
   identifiers (`reportSchedules`, `reportScheduleRuns`, `report_schedules`,
   `report_schedule_runs`) may be referenced **only** from the files above — a sweeping guard
   in the same test file, mirroring the existing single-helper pin style (spec 006 precedent).
5. `src/server.ts` (already swept) joins the cron-pass call; `wrangler.jsonc` unchanged (no new
   triggers — P37).
6. **Second lock in the same PR**: `shareTrustBoundary.test.ts` ("keeps schedules/token
   references hash-or-id-only") currently asserts `report_schedules` is absent from the four
   schema files. T006 flips it to assert the new tables reference shares by id/hash only
   (the G7 half of the old lock survives; only the non-existence half dies). The flipped file
   stays on the pinned-location allowlist since it must name the identifiers to guard them.

## Why same-PR

Plan §2.4 mandates it: the boundary test asserting non-existence fails the moment the schema
lands, so the flip is inseparable from the tables. The flip also *strengthens* the guard: the
pinned-location check keeps raw-token/`rankScore`-style leakage patterns out of the new surface
from day one (G7 evidence: `shareToken` remains a swept-for pattern in the schedule files —
fixtures assert `share_token`/raw-token strings never appear in schedule-related code paths).