# Contract: Schedule Runs — ledger, cron pass, delivery (US2 + US3)

## The ledger (P33 — the authority)

One row per `(scheduleId, scheduledFor)`, enforced by `UNIQUE(schedule_id, scheduled_for)` on
both dialects. **The run ledger — not the trace, not provider responses — is the sole authority
for what ran** (P42). State machine per [data-model.md](../data-model.md) §2.

### Claim semantics (research R1)

```
claimRun(scheduleId, scheduledFor):
  try INSERT run row (state: "claimed", claimedAt: now)
  catch unique-violation → SELECT existing row
    terminal state (delivered/partially_delivered/failed/skipped) → no-op (already done)
    non-terminal + fresh (claimedAt within window)                   → skip (another tick owns it)
    non-terminal + stale (claimedAt older than STALE_CLAIM_WINDOW=1h) → reclaim (own it)
```

- Claim IS the insert — no check-then-insert race exists.
- Failed retry: `failed → claimed` transition **on the same row**; the constraint forbids a
  second row for the period (SC-001/SC-002 anchors).

## Cron pass (`scheduledReportRuns.ts`, called from `src/server.ts scheduled()`)

Follows the `scheduledGa4Sync.ts` shape exactly (list → per-item try/catch, honest skip
logging):

```
runScheduledReportRuns():
  due = SELECT schedules WHERE active AND next_due_at <= now   (uses due index)
  for each schedule (per-item try/catch, [cron:reports] log prefix):
    scheduledFor = periodKeyOf(cadence, next_due_at)           # R2 derivation
    claim = claimRun(schedule.id, scheduledFor)                # R1 semantics
    if claim.outcome != owned: continue (logged, honest skip)
    try:
      row = ReportService.generateReport({...})                 # UNTOUCHED P31 generator
      transition → delivering (report linked; run RESTS here in US2)
      (G6 slice, US3) deliver per recipients …
      transition → delivered | partially_delivered | failed
    catch:
      transition → failed(failureClass)
    advance next_due_at on the schedule row (R2: late run targets passed date;
      missed-multi-period = one catch-up then advance)
```

- **Re-entry**: the same cron tick firing twice, or two Workers invocations racing — both hit
  the unique constraint; the loser skips. Test fixtures: sequential double-run, concurrent
  double-run, stale-claim reclaim, terminal-state no-op.
- **No render-time paid work (G10)**: the pass reads stored rows only; `generateReport` is the
  existing stored-data generator (its own provenance/consistency contract is inherited
  verbatim).
- Zero-row projects generate honestly-empty reports (P21): empty is a valid snapshot, not a
  failure — the run still delivers.

## Delivery slice (US3 — **hard-gated: no code until 009 = `EMAIL_DELIVERY_READY`**)

### Sender (`scheduledReportEmail.ts` — Loops auth paths in `loops.ts` stay frozen)

| Concern | Contract |
| --- | --- |
| Idempotency | `Idempotency-Key: sha256(scheduleId \| scheduledFor \| recipient)` header on every send (research R3) — provider-side dedup covers retries/re-execution for the recipient |
| Classification | `429`, `5xx`, network → **transient** (bounded: 2 retries/recipient/run); `400`, `404`, `401/403`, 409-mismatch → **permanent** (no retry); both recorded as `failureClass` |
| Missing config | absent `LOOPS_API_KEY` / `LOOPS_TRANSACTIONAL_SCHEDULED_REPORT_ID` → **fail closed before any request**; run state `failed`, `failureClass: missing_configuration` (never a silent skip; 009-observed honesty) |
| Log hygiene | logs carry status, classification, key-hash — **never recipient addresses** (009 finding: current paths log them; the new path fixes this day one; `recipient_outcomes` in the row stores hashes only) |
| Payload | link-based MVP (share reference) — **no attachments** (009: provider per-account enablement pending; deferred) |
| States | per [data-model.md](../data-model.md) §2: `delivered` (all sent), `partially_delivered` (some sent), `failed` (none sent + class), `skipped` (reason: `paused_before_send`, `no_recipients_after_validation`) |

### Trace / telemetry

- Cron pass + per-run outcomes log with the `[cron:reports]` console prefix and a
  per-pass summary line — exactly matching the existing passes (`scheduledGa4Sync`,
  `scheduledIntelligenceScan`), which emit no telemetry events. No new event type:
  per-run `generateReport` calls already emit their own `report:generate` telemetry.
- Run transitions never derive from trace (ledger-authoritative, P42).

## Test anchors (named suites, plan §Testing)

- `ReportScheduleRepository` / ledger: unique-violation catch path, stale-window reclaim,
  failed-row retry reuse (both dialect fixtures).
- `scheduledReportRuns`: sequential + concurrent double-invocation → exactly one report + one
  row (SC-001); failed→retry→success without duplicates (SC-002); paused-at-due produces no
  row; missed-multi-period → one catch-up then advance (SC-003 fixtures over a simulated
  3-month span).
- `cadence`: week/month boundaries, UTC derivation, late-run key correctness.
- `scheduledReportEmail` (gated): identical keys across retries (SC-006), transient retry bound,
  permanent no-retry, fail-closed config, log/output recipient-address leak audit (SC-007).