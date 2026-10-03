# Research — spec 012: Scheduled Reports (weekly/monthly email delivery)

Phase 0 research for `/specs/012-scheduled-reports/`. Resolves the four open decisions from
[plan.md](./plan.md). All findings verified against the repository and spec 009's verdict on
2026-10-03.

---

## R1 — Ledger claim semantics: exactly-once across concurrent cron invocations (D1 + PG)

- **Decision**: **claim-by-insert with unique-catch** — the claim IS the insert. The run ledger
  has a database-level `UNIQUE(scheduleId, scheduledFor)` constraint (both dialects, enforced via
  `uniqueIndex` — the established pattern in `src/db/app.schema.ts`). Claiming a due schedule
  inserts the ledger row (`state: "claimed"`) and treats a unique-constraint violation as
  "someone else won": catch, read the existing row, and skip. Generation/delivery then
  transitions the claimed row through the state machine. A failed run stays in the ledger with
  `state: "failed"` + `failureClass`; retry re-uses the SAME row (transition
  `failed → claimed`), never a second row — the unique constraint makes duplication
  structurally impossible on both dialects without a transaction manager.
- **Rationale**:
  - Workers/D1 has no cross-request locking primitive; PG deployments run through the same
    repository code. A database constraint is the only enforcement point that is *identical*
    on both dialects — the repo's own `onConflictDoUpdate` precedent
    (`ScanLedgerRepository.ts:236`) shows constraint-based concurrency is the house style.
  - Claim-before-do (insert the ledger row before generating anything) means a crash at any
    later point leaves a `claimed` row, which the next cron tick treats as a stale claim to
    reclaim (with a bounded staleness window), never as a fresh duplicate.
  - Alternative rejected — *conditional-then-insert* ("check no row exists, then insert"):
    the check and the insert race; the unique constraint still fires, but then the code has the
    same catch path anyway, so the check is dead weight. Doing the insert first is both
    simpler and always-safe.
  - Alternative rejected — *transactional SELECT FOR UPDATE*: D1 does not support row locks;
    it would silently fork the two dialects (P3 violation in spirit).
- **Test surface**: sequential double-invocation, concurrent double-invocation, stale-claim
  reclaim, failed→retry on the same row, and a succeeded-run re-entry (must no-op) — all
  unit-level against both dialect schemas.

## R2 — Cadence and `scheduledFor` derivation, late runs, paused/missed spans

- **Decision**: pure `cadence.ts` deriving dates in UTC:
  - `weekly`: `scheduledFor` = the Monday (ISO start-of-week) of the due week; `monthly`: the
    1st of the due month. `nextDueAt` on the schedule row is the *materialization* trigger
    (indexed, drives the cron due-query); `scheduledFor` is the *logical* identity (P33 key).
  - **Late runs target the passed due date**: a due schedule found at cron time runs for its
    `nextDueAt` date even if discovered hours late — "a late run is still that date's run".
  - **Missed multiple periods** (cron down for >1 period, or long pause): exactly one catch-up
    run for the most-recent missed period, then `nextDueAt` advances to the next future period.
    Silent multi-backfill surprises users (stale reports arriving in bursts); skipping forward
    silently hides an outage. One catch-up + advance is the honest MVP.
  - **Pause semantics**: paused schedules produce no runs and their `nextDueAt` freezes; on
    resume, `nextDueAt` is re-derived from the resume moment (resume = user action, per the
    spec's edge case). A schedule paused *at* due time simply isn't in the due query
    (`active AND nextDueAt <= now` — index-aligned).
- **Rationale**: UTC + date-keyed identity keeps `scheduledFor` a stable, human-checkable ledger
  key (`2026-10-05` vs `2026-10`) and lexicographically sortable on both dialects (the
  `Ga4SyncRepository` floor-comparison precedent). Month/week boundaries as *period keys* —
  not instants — sidestep "which exact hour?" questions the MVP never promised to answer.
- **Alternatives considered**: calendar-instant scheduling (cron-style `next` timestamps per
  user timezone — explicitly out of scope per spec Assumptions); per-run instant keys (breaks
  the P33 `(scheduleId, scheduledFor)` shape the plan mandates).

## R3 — Idempotency key derivation + delivery state machine

- **Decision**:
  - **Idempotency key** = `sha256(scheduleId | scheduledFor | recipient)` hex — one key per
    (run, recipient) so provider-side 24h dedup (Loops, per 009's documented 409-on-reuse
    behavior) covers exactly the retry window that matters. Derived deterministically from the
    ledger identity: a re-executed send after a crash presents the same key with no stored
    state required.
  - **State machine** (run row): `claimed → generating → delivering → delivered |
    partially_delivered | failed | skipped`. Delivery state derives from per-recipient outcomes
    (`recipientOutcomesJson`: per recipient `sent | transient_failed | permanent_failed`):
    all-sent → `delivered`; some-sent → `partially_delivered`; none-sent → `failed`.
    `skipped` is recorded with a reason (e.g. schedule paused between claim and send, recipient
    list empty after validation) — never conflated with failure (P21-adjacent honesty).
  - **Generation failure** never reaches delivery: `claimed → failed (generation)` with
    `failureClass: "generation"` and no send attempts.
- **Rationale**: keying per-recipient (not per-run) matches the provider's dedup granularity —
  a run with 3 recipients partially succeeded can retry the failed recipient without risking
  duplicates to the succeeded ones. Deterministic derivation (not a stored random key) means
  idempotency survives the very crash it protects against.
- **Alternatives considered**: per-run single key + provider batching (Loops transactional is
  per-recipient — no batching to key); stored send-attempt rows (a second ledger for delivery —
  rejected: the run ledger is authoritative, P42, and per-recipient outcomes live in the run
  row).

## R4 — Schedule-aware sender placement + Loops failure classification (gated slice)

- **Decision**: a new `scheduledReportEmail.ts` service inside the reports feature that owns the
  Loops HTTP call for scheduled sends (its own fetch with `Idempotency-Key` header + scrubbed
  logging) — **`src/server/email/loops.ts` is untouched** (auth paths frozen; 009 observed their
  semantics and this package must not drift them). Classification mapping (from 009's
  documented provider behavior):
  - **Transient**: 429 (rate limit — bounded retry with backoff), 5xx (bounded retry), network
    errors (bounded retry). Retry bound: 2 retries per recipient per run.
  - **Permanent**: 400 (bad request/unpublished template), 404 (template not found), 401/403
    (credentials), 409 with a *different* payload (idempotency misuse — surface, don't retry).
    No retry; run records `failureClass: "permanent_send"`.
  - **Missing credentials/template config**: fail closed before any request — run records
    `failureClass: "missing_configuration"` (never a silent skip; mirrors the 009-observed
    `getRequiredEnv` honesty).
  - **Log hygiene**: the sender logs status/classification/key-hash only — never recipient
    addresses (009's finding: current paths log them; that stays true for the frozen auth paths
    but is *fixed* for the new path from day one).
  - **Template**: `LOOPS_TRANSACTIONAL_SCHEDULED_REPORT_ID` env (created during 009's unblock
    prerequisites — referenced by ID, never inlined content).
- **Rationale**: 009's verdict blocked on exactly these unobservables (template ownership,
  credential tier) — so the design consumes its *recorded* facts (idempotency support, status
  semantics, attachment caveat) and isolates everything provider-shaped in one service the
  READY re-run can verify against live. Keeping `loops.ts` frozen preserves 009's evidence base.
- **Alternatives considered**: extending `loops.ts` with an options bag (rejected: every change
  to a shared path re-opens the spike's verified claims); queueing sends in a workflow
  (rejected: P37 — cron + run ledger suffice; a third execution layer is scope creep).

---

## Consolidated resolution table

| Unknown | Resolution | Contract/test anchor |
| --- | --- | --- |
| R1 exactly-once enforcement | Insert-as-claim + `UNIQUE(scheduleId, scheduledFor)` catch; stale-claim reclaim; retry reuses the row | contracts/schedule-runs.md; repository + scheduler suites |
| R2 cadence/late/paused semantics | UTC period keys (Monday / 1st); late runs target passed date; one catch-up then advance; pause freezes `nextDueAt` | cadence fixtures incl. 3-month simulation (SC-003) |
| R3 idempotency + delivery states | sha256(scheduleId, scheduledFor, recipient) per send; `delivered / partially_delivered / failed / skipped` derived from per-recipient outcomes | contracts/schedule-runs.md; sender suite (SC-005/006) |
| R4 sender placement + classification | New `scheduledReportEmail.ts` (Loops untouched); transient/permanent/missing-config classes; scrubbed logs; env-referenced template | contracts/schedule-runs.md §delivery; gated on 009 = READY |

All NEEDS-CLARIFICATION-class unknowns from plan.md Technical Context are resolved; none remain.
The G6 gate itself is not an unknown: it is a recorded hard gate with a structural gate-check
task (see spec FR-017).