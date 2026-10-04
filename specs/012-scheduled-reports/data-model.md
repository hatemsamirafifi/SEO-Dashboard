# Data Model — spec 012: Scheduled Reports

Phase 1 design artifact. Two new tables (additive, D1+PG parity per P3–P5); all other entities
(reports, shares) are existing and consumed, never redefined.

## 1. `report_schedules` (new — D1 `src/db/reports.schema.ts`, PG mirror)

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text PK | uuid at insert |
| `project_id` | text FK → projects | `onDelete: cascade` (deleted project removes schedules) |
| `organization_id` | text not null | tenancy |
| `report_type` | text not null | one of `REPORT_TYPES` (frozen vocabulary from `shared/reports.ts`) |
| `cadence` | text not null | `weekly` \| `monthly` (MVP set; enum locked by Zod + shared const) |
| `recipients` | text not null | JSON string array of emails; **deduplicated and lowercased at write time**; Zod-validated array with a bounded count (MVP: ≤ 10) |
| `share_id` | text nullable | reference to `report_shares.id` — **never a raw token** (P32/G7); present ⇒ email links to the shared view |
| `active` | integer boolean not null | default true |
| `paused_at` | text nullable | set on pause; cleared on resume (the "user action" marker) |
| `next_due_at` | text not null | UTC ISO datetime; the cron due-query key (`active AND next_due_at <= now`) |
| `last_run_at` | text nullable | display + honesty (FR-005); not a scheduling input |
| `created_by_user_id` | text nullable | audit |
| `created_at` / `updated_at` | text not null | `(current_timestamp)` defaults, house convention |

Indexes: `report_schedules_project_idx (project_id)`; `report_schedules_due_idx (active,
next_due_at)` — the cron pass's only query shape.

Validation rules (enforced at the Zod trust boundary + service):
- `cadence ∈ {weekly, monthly}`; `recipients` non-empty, each a valid email, deduped, ≤ 10;
  `share_id`, when present, must resolve to a share of a report in the same project.
- `report_type` must be one of the frozen `REPORT_TYPES`.
- No column ever stores a raw share token (fixture-driven leak audit named in quickstart V5).

## 2. `report_schedule_runs` (new — the P33 ledger)

| Column | Type | Constraints / notes |
| --- | --- | --- |
| `id` | text PK | uuid at insert |
| `schedule_id` | text FK → report_schedules | `onDelete: cascade` |
| `scheduled_for` | text not null | period key: `YYYY-MM-DD` (Monday) or `YYYY-MM-01` — see research R2 |
| `report_id` | text nullable FK → reports | set after generation; null while claimed/failed-generation |
| `state` | text not null | `claimed` \| `generating` \| `delivering` \| `delivered` \| `partially_delivered` \| `failed` \| `skipped` |
| `failure_class` | text nullable | `generation` \| `transient_send` \| `permanent_send` \| `missing_configuration` \| null |
| `skip_reason` | text nullable | e.g. `paused_before_send`, `no_recipients_after_validation` |
| `recipient_outcomes` | text nullable | JSON array: `{ recipientHash, outcome: sent\|transient_failed\|permanent_failed }` — hashed addresses (log-hygiene extends to at-rest payloads) |
| `claimed_at` | text not null | insert timestamp; staleness window anchor |
| `completed_at` | text nullable | terminal-state timestamp |
| `created_at` / `updated_at` | text not null | house convention |

**Hard constraint**: `UNIQUE(schedule_id, scheduled_for)` via `uniqueIndex` on both dialects —
the exactly-once enforcement point (research R1). Index:
`report_schedule_runs_schedule_idx (schedule_id, scheduled_for)`.

### State transitions (derived per run, ledger-first)

```
(insert-as-claim)            stale-claim reclaim (bounded window)
        │                            │
        ▼                            ▼
     claimed ──generation starts──▶ generating ──▶ delivering ──┤ all sent ──▶ delivered
        │                                │             │        ├ some sent ──▶ partially_delivered
        │                                │             │        └ none sent ──▶ failed (send class)
        │                                └ generation threw ─▶ failed (generation)
        └ paused/no-recipients between claim and send ─────▶ skipped (reason)
     failed ──cron retry──▶ claimed (SAME row; unique constraint forbids a second)
```

- Claim IS the insert (`state: "claimed"`); unique-violation = "another invocation won" → read
  row, skip. Stale `claimed/generating/delivering` rows (bounded window, e.g. 1h) are reclaimed
  by the next tick; succeeded runs are never re-entered (terminal states no-op).
- Failed runs retry by transitioning their own row back to `claimed` — the constraint makes a
  duplicate for that `(schedule_id, scheduled_for)` structurally impossible (SC-001/SC-002).

## 3. Existing entities consumed (never redefined)

- **reports** (`reports` table, P31): generated rows via the untouched
  `ReportService.generateReport` — frozen payload, dual-sided provenance, branding snapshot.
  The ledger's `report_id` links a run to its immutable snapshot.
- **report_shares** (005): referenced by `share_id`/`tokenHash` for email links; raw token
  exists only in the one-time creation response of the existing share flow — this package
  never receives, stores, or logs it.
- **report_events**: the existing lifecycle audit table gains no new event types in MVP
  (schedule/run audit lives in the run ledger + trace entries, P41–P42).

## 4. Derived values (pure, no storage)

- **`nextDueAt` derivation** (`cadence.ts`): weekly → next Monday 00:00 UTC; monthly → 1st of
  next month 00:00 UTC; resume re-derives from the resume moment (research R2).
- **`scheduledFor` derivation**: weekly → the due week's Monday (`YYYY-MM-DD`); monthly →
  `YYYY-MM-01`. Lexicographically sortable on both dialects (Ga4Sync floor-comparison
  precedent).
- **Idempotency key**: `sha256(scheduleId | scheduledFor | recipientEmail)` — per (run,
  recipient), deterministic, stateless (research R3).
- **Delivery state**: from `recipient_outcomes` — all `sent` → `delivered`; any `sent` →
  `partially_delivered`; none `sent` → `failed`; no send attempted with reason → `skipped`.