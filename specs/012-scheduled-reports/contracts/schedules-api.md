# Contract: Report Schedule Management API (US1)

Audience: the Reports management UI (`ReportSchedulesPanel`, `ScheduleEmailModal`), the
authorization tests, and MCP surfaces if schedules are ever exposed there (MVP: not exposed).

## Server functions (`src/serverFunctions/reports.ts`)

All five run through the existing `requireProjectContext` middleware (project-scoped auth per
P39; same shape as the existing report fns in that file). Zod schemas in
`src/types/schemas/reports.ts` are the trust boundary.

| Function | Input (beyond project context) | Output | Notes |
| --- | --- | --- | --- |
| `createReportSchedule` | `reportType` (frozen enum), `cadence` (`weekly` \| `monthly`), `recipients` (email[], ≤10, deduped+lowercased server-side), `shareId?` | schedule row | `shareId` validated to belong to this project; `nextDueAt` derived at create |
| `updateReportSchedule` | `scheduleId`, any of the above fields | schedule row | recipients re-validated; editing never touches run history |
| `pauseReportSchedule` | `scheduleId` | schedule row | sets `active=false`, `pausedAt`; **`nextDueAt` freezes** (pause is a user action, not a failure) |
| `resumeReportSchedule` | `scheduleId` | schedule row | clears `pausedAt`, re-derives `nextDueAt` from resume moment |
| `listReportSchedules` | — | schedules + last-run summary per schedule | last-run = latest run row (`state`, `completedAt`, `scheduledFor`); honest states per FR-005 |

Deletion rides the existing report-delete surface semantics if the product wants it later;
MVP ships create/edit/pause/resume/list (the spec's US1 acceptance set).

## Validation rules (Zod, mirrored in service)

- `reportType ∈ REPORT_TYPES` (frozen `shared/reports.ts` vocabulary).
- `cadence ∈ {weekly, monthly}` — new `REPORT_SCHEDULE_CADENCES` const in `shared/reports.ts`.
- `recipients`: non-empty, each email-shaped, count ≤ 10, server-side dedupe + lowercase
  (duplicate across list is an edit-time fix, not a send-time surprise).
- `shareId`: when present resolves to a `report_shares` row for a report in the same project —
  else `VALIDATION_ERROR`.

## UI contract (`ReportSchedulesPanel` + `ScheduleEmailModal`)

- Panel shows per schedule: cadence label, recipient count (not the raw list — click to
  reveal), report type, `nextDueAt` (derived display), last-run state chip using the **same
  honest-state vocabulary as the rest of the app** (succeeded / partially delivered / failed /
  skipped / not yet run), and pause/resume affordances.
- States: loading / ready / empty (no schedules yet — setup guidance, not an error) / error
  (explicit retry). Zero schedules and failed reads are distinct (P30 vocabulary).
- The modal never displays or transmits a raw share token — it links an existing share by
  picking from the project's share list (id + label).

## Authorization

- Every fn: project context (existing middleware) — mirrored auth tests in
  `serverFunctions/reports.schedules.authorization.test.ts` covering wrong-project access,
  unauthenticated access, and cross-org leakage.
- Cron paths are system-scoped (no user context — same as the existing four passes) and write
  no user-identifying audit data beyond what run rows already carry.