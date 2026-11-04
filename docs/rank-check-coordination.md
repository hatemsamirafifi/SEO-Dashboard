# Rank-check dispatch: method selection & DataForSEO account coordination

How rank checks reach DataForSEO, and how concurrent workers sharing one
DataForSEO account are kept from multiplying its outbound request
concurrency.

## Method selection (Live vs Standard Queue)

`resolveRankCheckMethod(trigger, scopedKeywordCount)` in
`src/shared/rank-tracking.ts` is the single rule, evaluated on the **actual
scoped/eligible keyword count after all filters** (one keyword with both
devices still counts as one keyword):

| Trigger   | Scoped keywords | Method         |
| --------- | --------------- | -------------- |
| scheduled | any             | Standard Queue |
| manual    | exactly 1       | Live (instant) |
| manual    | more than 1     | Standard Queue |

The same helper drives all four places that must agree:

1. the workflow's execution branch (`RankCheckWorkflow.runScoped`),
2. the hosted credit precheck in `prepareRankCheckKeywords`,
3. the client cost/time copy (`CheckConfirmModal.runNowCopy`,
   `MissingRankingsConfirmModal.runMissingRankingsCopy`,
   `RankTrackingConfigModal`, `rankTrackingCost.formatRankTrackingCost`).

Queued bulk checks never show instant-results time: the UI shows
`QUEUED_RESULTS_WINDOW_TEXT` ("Results in ~5–15 min") instead of a
seconds-based ETA.

## Bulk queue failure policy (`rankCheckPaths.runQueuedCheck`)

- Posts run as single-attempt workflow steps at **normal priority**; accepted
  provider task IDs are persisted in workflow step results.
- **No automatic Live resubmission** for any queue rejection, error,
  cancellation, or polling timeout, and no blind retries of an ambiguous paid
  POST. Everything that never produces a queue result is persisted as a
  `CHECK_FAILED` snapshot with a per-pair diagnostic (post failure, post-time
  rejection with DataForSEO's status message, DataForSEO task failure, or
  "not collected within the polling window").
- Tasks **already accepted** by earlier chunks keep being collected even when a
  later post batch fails — they were paid for at `task_post`.
- Collection (`task_get`) is free and binds to the same effective DataForSEO
  account the posts used (see below), so it never double-bills.

## Account coordination gate

`dataforseo_account_request_slots` (one row per DataForSEO account) is a
persistent, cross-worker single-slot mutex. The account identifier is a
SHA-256 hash of the **effective login only** — the same login with different
API passwords is the same account; different logins stay independent. No
credentials are ever persisted.

Wired into the real dispatch path in `src/server/lib/dataforseo/serp.ts`, the
gate wraps **every rank-check DataForSEO dispatch**: `task_post`,
`task_get`, and the single-keyword Live check. One credential resolution
decides both the coordinated account and the pinned credentials for the
dispatch (`resolveDataforseoAccountBinding` in `core.ts` re-binds the
resolved pair around the gated SDK call, so settings drift while waiting on
the slot can never redirect a request to a different account). A legacy
base64 `login:password` API key hashes to its parsed login, so it coordinates
on the same slot as settings credentials with that login.

Mechanics (`dataforseoAccountGate.ts`):

- **Acquire**: one atomic conditional `UPDATE` (`free_at <= now`, bump
  `epoch`) — or a first-seen `INSERT ... ON CONFLICT DO NOTHING`.
- **Release**: fenced by the epoch counter, sets `free_at = now + pacing`
  (default 150ms gap between consecutive requests to the same account). A
  stale owner's release matches zero rows.
- **Crash recovery**: a holder that dies without releasing is reclaimed by
  the next acquirer once the lease (default 120s) lapses. This covers the
  45s acquisition window and the shared fetch's ~61s hard cap (60s
  `AbortSignal` across ≤3 attempts).
- **Bounded, cancellation-aware wait**: the deadline starts at call time and
  covers queue time + acquisition (default 45s, leaving the bulk of a
  2-minute workflow step for the actual request). An `AbortSignal` and an
  async `isCancelled` callback (the rank-check run's DB status) are checked
  while waiting and once more **immediately before dispatch** — a cancelled or
  timed-out request is never sent later. Waits poll the shared row at a
  modest jittered cadence (≥500ms in production); there is no in-process
  fairness structure. Cross-worker ordering is not guaranteed; the database
  is the authority for mutual exclusion.
- **Fail closed**: coordination-storage errors abort the request before
  dispatch. Nothing is ever sent "around" the gate.
- No Postgres transaction or worker-wide lock is held while waiting; each
  poll is a single statement that completes before the next starts.

Collection runs inside `runWithDataforseoAccountContext` with the billing
scope of the posts (`organizationId`/`projectId`), so a project-level
credential override applies to `task_get` exactly as it did to `task_post`.
Settings lookup failures stop collection rather than silently selecting
another account. Collection uses durable batches of at most 50 requests;
completed batches survive a later batch failing. Every pending task gets a
collection attempt in each polling round, regardless of the config size.

Account coordination covers workers and projects sharing this application
database. Other applications and deployments with separate databases have
independent queues.

## Migration notes

`drizzle/0077_dataforseo_account_request_slots.sql` (SQLite/D1) and
`drizzle-pg/0055_dataforseo_account_request_slots.sql` (Postgres) create the
table on both dialects. They follow the same hand-written forward-migration
precedent as `0076_indexnow_key` / `0054_indexnow_key` (journal entry, no new
drizzle-kit snapshot): the repo's historical drizzle snapshot chain already
contains pre-existing fork collisions that block `drizzle-kit generate`, and
repairing that history is intentionally out of scope for this feature.
