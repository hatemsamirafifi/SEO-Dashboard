# Feature Specification: Next Actions

**Feature Branch**: `feat/p1-next-actions`
**Created**: 2026-10-26
**Status**: Implemented - Phase 9 delivered 2026-10-26: the action center rides the existing opportunities engine end to end (no parallel table, engine, or scoring): `assignee`/`effort` columns land via one small dual-dialect migration (0071/0049) with idempotent content-keyed triage events that never touch lifecycle or scores; the list contract gains server-side recency (inclusive `lastDetectedAt` window, echoed to the UI) and reopened (stored recurrence chain only) filters; a `getNextActions` snapshot derives the critical/recent/completed/reopened views from one stored read with honest pre-cap counts and deterministic ordering, surfaced as a dashboard section plus a detail-page triage form; autopilot closes the loop by appending per-occurrence `completion_evidence` events (idempotent per occurrence+run, failure-isolated) after a run completes. Two baseline defects fixed en route (`throttleit` undeclared devDependency; a wall-clock freshness time-bomb in the autopilot suite). Unit suites, schema parity, `tsc`, Prettier on changed files, oxlint, and knip (no new findings) are clean; the full suite has the one pre-existing env-gated live-API failure; `pnpm build` is green (see `docs/plans/reports/2026-10-26-next-actions-phase9-verification.md`).
**Input**: Master plan (`docs/plans/2026-10-17-p1-seo-intelligence-implementation.md` section 3.2 row 9): "Unified action center over existing `opportunities` (NO parallel engine): dashboard section w/ filters (feature/severity/lifecycle/recency/reopened), critical/recent/completed/reopened views; autopilot close-the-loop hooks (completion evidence events); assignee/effort columns only via small approved migration; dedup via existing logicalKey engine."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See what to act on now (Priority: P1)

A project owner opens the project dashboard and sees a Next Actions section
with four views: critical (highest-priority open items), recent (newly
detected), completed (finished items), and reopened (items that came back
after being closed). Each row links to the existing opportunity detail, and
every view states its counts from stored rows — an empty view renders empty,
never a zeroed "ready" state.

**Why this priority**: The intelligence engine already produces scored,
lifecycle-managed opportunities; the missing piece is one place that answers
"what do I do next" without visiting the full list.

**Independent Test**: Seed opportunities across priorities, ages, and
lifecycle states (including a recurrence chain); assert each view returns the
expected rows in canonical order and the section state is `empty` (not
`ready`-with-zeros) when no rows match.

**Acceptance Scenarios**:

1. **Given** open Critical/High opportunities, **When** the critical view is
   read, **Then** the highest-priority items appear in the existing canonical
   order (priority, impact, confidence, lastDetectedAt).
2. **Given** opportunities first detected in the last N days, **When** the
   recent view is read, **Then** only those appear, newest first.
3. **Given** completed opportunities, **When** the completed view is read,
   **Then** they appear with their completion timestamps.
4. **Given** an opportunity that recurred after dismissal, **When** the
   reopened view is read, **Then** the new occurrence appears and is derived
   from the stored recurrence chain — never recomputed heuristically.

### User Story 2 - Triage with the full filter set (Priority: P1)

The owner narrows any view by feature (type), severity (priority), lifecycle
(status), recency (a freshness window on `lastDetectedAt`), and reopened
state, composable with the existing page/keyword/source filters. Assignee and
effort are the only new columns — added by one small dual-dialect migration —
and setting them goes through the existing update path with a lifecycle
event, so triage history stays in the append-only ledger.

**Why this priority**: Filters and triage fields turn the section from a
report into a work queue.

**Independent Test**: Seed rows and assert server-side AND-composition with
OR-within-dimension (arrays), recency bounds, reopened derivation, and that
an assignee/effort update appends exactly one idempotent event.

**Acceptance Scenarios**:

1. **Given** filters `types=["technical","backlinks"]` and
   `priorities=["Critical"]`, **When** the list is read, **Then** only rows
   matching both dimensions return (OR within, AND across).
2. **Given** `recentDays=7`, **When** the recency filter applies, **Then**
   only rows with `lastDetectedAt` inside the window return, and the applied
   window is echoed in the response for the UI to display.
3. **Given** `reopened=true`, **When** the filter applies, **Then** only
   occurrences with a stored recurrence chain return.
4. **Given** an assignee change, **When** it is saved, **Then** the column
   persists (both dialects) and a triage event lands in `opportunity_events`
   once per change, idempotent across retries.

### User Story 3 - Autopilot closes the loop (Priority: P2)

When an autopilot step that consumed collected opportunities finishes, a
completion-evidence event is appended to each referenced occurrence, so the
owner can see, on the opportunity itself, that automation acted on it and
with what outcome. A failing evidence append never fails the step.

**Why this priority**: Without the loop closed, automated work and the action
center drift apart; the event ledger is the existing, idempotent seam.

**Independent Test**: Run a stubbed step that references two opportunity ids;
assert one evidence event per occurrence with the step/run ids in the
payload, idempotency across a retried append, and step success when the
append throws.

**Acceptance Scenarios**:

1. **Given** a completed autopilot step that ranked opportunities X and Y,
   **When** the hook runs, **Then** one evidence event lands on X and on Y
   with the step id, run id, and outcome in the payload.
2. **Given** the same step re-executed (retry/resume), **When** the hook runs
   again, **Then** no duplicate events are appended (eventKey idempotency).
3. **Given** a failing event append, **When** the step finishes, **Then** the
   step outcome is unchanged and the failure is reported on its own.

## Edge Cases

- A view with no matching rows renders `empty` — never zeroed metrics or a
  fabricated "ready" state.
- `reopened` is a property of the stored recurrence chain
  (`occurrenceNumber > 1` / `recurrenceOfId`); a merely stale or re-scored
  opportunity is never "reopened".
- Recency uses `lastDetectedAt` (not `firstDetectedAt`) so long-lived items
  that keep being confirmed stay visible in recent.
- Assignee is a free-form label; no user-directory resolution in this phase.
- Effort is a nullable enum (`small|medium|large`); absence is honest
  (`null`), never "unknown" text.
- Terminal rows stay terminal: triage updates never resurrect a
  completed/dismissed occurrence.
- Evidence events reference occurrences, not logical keys, so a recurred
  occurrence keeps its own history.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The action center MUST read and write only the existing
  opportunities engine (logicalKey dedup, lifecycle, event ledger); no
  parallel table, engine, or scoring path may be introduced.
- **FR-002**: A Next Actions dashboard section MUST expose the four views
  (critical, recent, completed, reopened) as stored reads with explicit
  section states (loading/empty/no_data/… via the shared state model), each
  row linking to the existing opportunity detail.
- **FR-003**: Filters MUST extend the existing composable filter contract:
  type (feature), priority (severity), status (lifecycle) — including the
  existing array forms — plus recency (inclusive `lastDetectedAt` window from
  an injected day bound) and reopened (stored recurrence chain); all
  dimensions AND-compose, arrays OR-within-dimension.
- **FR-004**: `assignee` (nullable text) and `effort` (nullable
  small|medium|large) MUST be added to `opportunities` in both dialects via
  one small migration pair with the parity suite extended.
- **FR-005**: Assignee/effort changes MUST flow through an existing-style
  update service that appends one idempotent triage event
  (`eventKey`-deduplicated) to `opportunity_events` and never changes status,
  scores, or identity columns.
- **FR-006**: The reopened view and filter MUST be derived from stored
  recurrence chains only.
- **FR-007**: Autopilot step completion MUST append a completion-evidence
  event to each occurrence the step referenced (step id, run id, outcome in
  the payload), idempotent via eventKey, isolated so a failing append never
  changes the step outcome.
- **FR-008**: Every new read/update MUST be project-scoped and pass the
  existing authorization middleware patterns (including the
  `*.authorization.test.ts` convention).
- **FR-009**: No detector, scorer, provider, or paid-call path may change.

### Non-Functional Requirements

- **NFR-001**: Bounded reads: each dashboard view is capped by an injected
  limit; filters run server-side (the list contract), never by shipping the
  full table to the client.
- **NFR-002**: Deterministic ordering everywhere: the shared canonical
  opportunity comparator; recent/completed use timestamp order with stable
  tiebreaks (id).
- **NFR-003**: Both dialects stay in parity (4 artifacts per schema change;
  parity test green) and rows remain JSON-serializable.
- **NFR-004**: The UI follows the existing dashboard card/section patterns
  with explicit loading/failure/empty states; no new component library or
  styling system.

### Key Entities

- **NextActionView**: critical | recent | completed | reopened — a stored
  read over `opportunities` with its own ordering rule.
- **OpportunityTriage**: the assignee/effort columns plus their triage
  events.
- **CompletionEvidence**: an autopilot-authored `opportunity_events` row
  linking a finished step to the occurrences it acted on.

## Success Criteria _(mandatory)_

- **SC-001**: The dashboard section renders all four views from seeded rows
  in the expected orders with honest empty/no-data states.
- **SC-002**: The filter contract composes server-side, including the new
  recency and reopened dimensions, and echoes applied bounds.
- **SC-003**: Assignee/effort persist in both dialects and append exactly one
  idempotent event per change; terminal rows are never resurrected.
- **SC-004**: An autopilot step's completion appends evidence events to its
  referenced occurrences, idempotently, without affecting the step outcome.
- **SC-005**: No parallel engine exists: dedup, lifecycle, and scoring still
  come solely from the existing logicalKey path.
- **SC-006**: Unit suites, schema parity, `tsc`, Prettier on changed files,
  oxlint, knip (no new findings), the full Vitest suite (one known env-gated
  live-API failure excepted), and `pnpm build` are green.

## Assumptions

- The existing list service/filter schema extends in place; the dashboard
  section reuses the same service rather than a second query stack.
- The recency default is an injected threshold (reasoned prior: 7 days),
  recalibratable without code changes.
- Assignee is a label, not a foreign key to a user directory (no assignment
  model exists in the product yet).
- Autopilot steps already carry the ranked opportunity ids they consumed
  (`rankedIds`), so the close-the-loop hook needs no new collection logic.
- The dashboard's stored-rollup section framework (states + meta) is the
  rendering seam; no new section-state machinery is invented.
