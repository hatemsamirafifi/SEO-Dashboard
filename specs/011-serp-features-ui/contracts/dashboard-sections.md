# Contract: Dashboard Intelligence Sections + Unified 11-State Model (PR12 A1 / PR13 A2)

## A1 — Section inventory (existing spec-001 rollup contracts; read-only)

Eight sections, all backed by `DashboardService.getIntelligenceOverview` stored reads:

| Section | Source | Metrics contract |
| --- | --- | --- |
| SEO performance | GSC stored rollups | clicks, impressions, CTR, avg position (PeriodDelta) |
| Search visibility | Rank stored snapshots | top3/top10/top100 deltas, improved, declined, tracked count |
| Traffic & engagement | GA4 stored rollups | sessions, organic sessions, engaged sessions, engagement rate |
| Conversions | GA4 stored rollups (+011: project goals from spec 010 where defined) | key events (name + delta), transactions |
| Opportunities | stored opportunities (010 filters apply) | critical/high/medium counts, open total |
| Technical health | latest stored audit | audit summary + `lastAuditAt` |
| Backlinks | stored backlink snapshot | backlink/RD counts + new/lost deltas + capturedAt |
| Recent changes | stored insights | latest items (fact/recommendation separated), dismissed count |

**A1 guarantees (this package enforces + tests, mostly already true):**

1. Every displayed number equals the stored rollup for the same project + window (SC-004) —
   no render-time recomputation from raw grains, no live provider calls (P29, G10).
2. A not-connected source renders `not_connected`; a zero-row success renders `no_data` or
   `empty` per section kind; a failed read renders a failure state (SC-002/P30/P9).
3. The `conversions` section lists project-defined goals (010) by their stored names when goals
   exist; without goals it renders the existing keyEvents list. No goal logic is invented here.

## A2 — Unified 11-state section model

**Single mapping home**: `mapStoredSectionState` in `src/shared/intelligence.ts` (extended input
per [data-model.md](../data-model.md) §3). States (verbatim P30, locked by test):

`loading · ready · empty · not_connected · no_data · partial · stale · api_failed ·
permission_failed · sync_running · sync_failed`

**Deterministic precedence (first match wins)**:

```
loading → not_connected → permission_failed
→ (!hasCurrent && sync_running) → (!hasCurrent && sync_failed) → api_failed
→ no_data → empty → stale → partial → ready
```

(Sync states are scoped to missing current coverage: with current data the section keeps its
data state and annotates via `coverage.detail` — preserved spec-001 behavior.)

**Contracts every section honors:**

- **One outcome, one state** (FR-012): each `get*Section` computes `MapStoredSectionStateInput`
  flags from its stored reads and calls the mapper; direct `state:` assignments in section code
  are removed. `safeSection` remains the exception backstop and maps to `api_failed`.
- **Failure ≠ empty** (FR-014): `api_failed`/`sync_failed`/`permission_failed` render explicit
  failure UI with retry; they can never produce `empty`/`no_data`/`ready` via any input
  combination (matrix tests pin this).
- **Loading is real**: while a section's stored read is in flight, the view renders `loading`,
  not last-session leftovers; stale-with-data renders `stale` only with a freshness note from
  `coverage.freshness`.
- **Partial is truthful**: `partial` requires current-window coverage with missing previous
  window; delta fields stay null — never synthetic percentages (existing `toPeriodDelta` law).
- **View mapping**: each section component renders through a shared `SectionStateShell`
  (loading skeleton / failure + retry / empty / not-connected CTAs), receiving `metrics` only in
  `ready`/`partial`/`stale`. No bespoke per-section error cards remain.

**State matrix (test surface)** — every combination class below × all eight sections where
applicable: loading; not connected; permission failed; sync running; sync failed; read failed;
no data; empty list; stale snapshot; partial window; ready. Server-side matrix generated from the
decision table (parametrized unit test on the mapper + per-section adapter tests), plus one
client render assertion per state. E2E spot-checks the three most safety-critical paths
(`api_failed` with retry, `not_connected`, `empty`).

## Trace / observability

State transitions add no trace writes (trace is for operations, P41); a section that resolves to
`api_failed` is already covered by the existing `safeSection` console/telemetry path.
