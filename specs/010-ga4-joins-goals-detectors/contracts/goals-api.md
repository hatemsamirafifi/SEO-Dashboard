# Contract: GA4 Goals API

**Feature**: `010-ga4-joins-goals-detectors` | **Date**: 2026-10-01
**Layering**: TanStack server fn (`requireProjectContext`) → `Ga4GoalService` → `Ga4GoalRepository` (P1).
See [data-model.md](../data-model.md) for the table shape; [research.md R1](../research.md) for the
binding decision.

## Server functions (all `method: "POST"`, project-context middleware, Zod-strict validators)

### `createGa4Goal`

- **Input**: `{ projectId, name: string(1..100 trimmed), eventName: string(1..100 trimmed),
  matchKeyEventOnly: boolean = false }`
- **Behavior**: enforces active-goal cap (default 20 → `VALIDATION_ERROR` naming the cap); name unique
  among active goals (`VALIDATION_ERROR`); persists; emits `ga4_goal_change` trace.
- **Output**: `{ goal }` — `Ga4GoalRow` (id, projectId, organizationId, name, eventName,
  matchKeyEventOnly, archivedAt, createdAt, updatedAt).
- **Failure**: invalid shape → validation error; wrong project context → auth error (P39).

### `listGa4Goals`

- **Input**: `{ projectId, includeArchived: boolean = false }`
- **Output**: `{ goals: Ga4GoalRow[] }` ordered by `createdAt asc`. Active-only by default.
- **Honest states**: no GA4 connection is NOT required to list goals (goals are OpenSEO-owned rows);
  the list may be empty (valid empty — rendered as explicit empty state, not error).

### `updateGa4Goal`

- **Input**: `{ projectId, id, name?, eventName?, matchKeyEventOnly? }`
- **Behavior**: only active goals are editable (archived → `VALIDATION_ERROR` "archived goal is
  read-only"); unique-name check among actives excluding self; archived goals' historical evidence is
  never rewritten (evidence freezes `goalId` + name at emission).
- **Output**: `{ goal }`.

### `archiveGa4Goal`

- **Input**: `{ projectId, id }`
- **Behavior**: idempotent on already-archived (returns current row, no error — archive is a
  terminal-ish soft state, re-archive is a no-op); sets `archived_at` (now).
- **Output**: `{ goal }`.

## Goal-scoped analytics filtering (read contract)

The existing analytics schemas (`analyticsOverviewSchema`, `analyticsAcquisitionSchema`,
`analyticsLandingPagesSchema`, `analyticsEventsSchema`, `analyticsConversionsSchema` —
`src/types/schemas/ga4.ts`) gain an optional `goalId: z.string().min(1).optional()`:

- **Semantics**: when `goalId` is present, conversion/conversion-adjacent figures are scoped to that
  goal's event binding (R1: `event_name = goal.eventName` + `matchKeyEventOnly` flag) computed from
  stored `ga4_daily_events` sums over SUCCESS_*-covered dates. Other metrics are unaffected.
- **Invalid `goalId`** (unknown, other-project, or archived): `NOT_FOUND`-class error — never a silent
  empty result (failure ≠ empty, P9).
- **Zero-row success**: a goal whose event has no rows in the window renders **no-data** (`AnalyticsCoverage`
  status `none`), never zero conversions (P21/P23/P30).
- **User-summing ban**: goal conversion aggregates are event-count sums only; no read path in this
  contract sums `users`/`newUsers`/`activeUsers` across grains or periods (P23) — enforced by a
  dedicated test asserting the SQL/aggregate shape.

## MCP wrappers (thin)

`get_analytics_acquisition` / `get_analytics_events` / `get_analytics_conversions` MCP tools accept the
same optional `goalId`, delegating to the same service methods — no independent MCP logic (P1.5). Errors
surface as structured tool errors with the provider-accurate classification (no fabrication).

## Invariants (tested)

1. Every operation validates project scope; cross-project ids fail closed.
2. Cap, uniqueness, and archived-read-only transitions are enforced in the service (repository stays
   persistence-only, P4).
3. Archived goals never mutate; evidence referencing them stays frozen.
4. Trace entries for create/update/archive contain no secrets (P41).