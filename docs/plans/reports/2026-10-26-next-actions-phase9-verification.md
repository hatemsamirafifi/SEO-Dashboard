# Phase 9 - Next Actions Verification (spec 021)

Date: 2026-10-26
Branch: `feat/p1-next-actions`
Base: wave 3 integration baseline (`c99640c1`, phases 1-7)
Worktree: `F:\SEO-Dashboard-worktrees\p1-next-actions`

## A. Repository Assessment

- Reused the entire opportunities engine: `logicalKey` dedup, the
  lifecycle + event ledger, the shared canonical comparator, the section-state
  vocabulary, `requireProjectContext` middleware, the authorization-test
  harness, and the autopilot journal-driven test DB. The dashboard section,
  the filters, the triage fields, and the evidence loop are additive reads and
  writes over those seams — no parallel engine (FR-001/SC-005).
- One small migration pair, exactly as the master plan allows: two nullable
  `opportunities` columns in both dialects.
- No detector, scorer, provider, or paid-call path changed (FR-009).
- Baseline defects found and fixed along the way:
  1. `throttleit` was imported by a committed test (`samStreamingThrottle.test.ts`)
     but never declared — knip had flagged it as an unlisted dependency, masked
     by a stale top-level link in another worktree's `node_modules`. Declared it
     as a devDependency (the fresh worktree surfaced the missing `tsc`).
  2. A time-bomb test: `AutopilotService.test.ts` seeded a fixed
     `lastDetectedAt` (2026-09-28) against the service's wall-clock 28-day
     freshness gate, so the test detonated at 2026-10-26T00:00Z. The fixture is
     now wall-clock relative; the deliberately stale fixture (2026-01-01) that
     asserts the locked path is unchanged.

## B. Implementation Status

| Deliverable                        | Status   | Evidence                                                                                                                                                                                                                      |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignee`/`effort` columns         | COMPLETE | `src/db/opportunities.schema.ts` + `src/db/pg/opportunities.schema.ts`; migrations `drizzle/0071_next_actions_triage.sql` and `drizzle-pg/0049_next_actions_triage.sql`, journals retagged; every DB-bootstrapping test suite applies the migration (FR-004) |
| Recency + reopened filters          | COMPLETE | `listOpportunitiesSchema` gains `recentDays` (inclusive window on `lastDetectedAt`) and `reopened`; the repository adds `recentSince`/`detectedSince`/`reopened` conditions; the list server fn echoes the applied `recentSince` (FR-003) |
| Triage update                       | COMPLETE | `updateOpportunityTriage` rides the existing update path: unchanged values are a no-op, the `triage_changed` event key is content-derived (retries replay once), and lifecycle/score/identity columns are untouchable (FR-005) |
| Next-actions snapshot               | COMPLETE | `nextActions.ts` module: critical (canonical order), recent (`firstDetectedAt` window, newest first), completed, reopened (stored recurrence chain only), honest pre-cap counts, deterministic id tiebreaks (FR-002, FR-006, NFR-002) |
| Server functions + authorization    | COMPLETE | `updateOpportunityTriage` + `getNextActions` behind `requireProjectContext`; the authorization suite now covers all five endpoints including the new filter shapes (FR-008) |
| Dashboard section                   | COMPLETE | `NextActionsSection.tsx`: four views with counts, loading/error/empty states, links into the existing detail; wired into `DashboardPage` (NFR-004) |
| Detail triage                       | COMPLETE | `TriageSection` on `OpportunityDetail`: dirty-checked save, `null` clears, effort enum select, invalidation of detail + list queries |
| List-page filters                   | COMPLETE | Recency select (7/30/90 days) + "Reopened only" checkbox compose with the existing server-side filter bar and its clear-filters parity |
| Autopilot close-the-loop            | COMPLETE | `opportunityEvidenceLoop.ts`: after a run completes, every occurrence a step's evidence referenced gets one `completion_evidence` event (run/attempt/workflow/outcome + step refs), idempotent per (occurrence, run), per-occurrence failure isolation; `insertEventIgnoreConflict` now reports whether the row landed so replay counts stay honest (FR-007) |
| Event vocabulary                    | COMPLETE | `triage_changed` and `completion_evidence` added to `OPPORTUNITY_EVENT_TYPES` |

## C. Crawler Verification

Not applicable; the crawler, audits, and detectors are untouched.

## D. Feature Verification

- No parallel engine: every view, filter, and triage write goes through the
  existing repositories/service; dedup and scoring still come solely from the
  materializer path.
- Reopened honesty: derived from `recurrenceOfId`/recurrence chains only — a
  stale or re-scored opportunity never counts as reopened.
- Recency honesty: the list filter bounds `lastDetectedAt` (long-lived items
  stay visible) while the recent view bounds `firstDetectedAt` (newly
  detected); the applied window is echoed to the UI.
- Triage safety: unchanged values emit nothing; a cleared triage on a
  completed row keeps the row completed (tested); terminal rows stay terminal.
- Evidence loop: corrupt step evidence is skipped while other steps still
  process; a retried drive for the same run appends nothing; a failing append
  is logged per occurrence and never changes the run outcome; the hook itself
  is wrapped in `stepExecutor` so even a total failure cannot change the
  persisted run completion.
- Authorization: wrong-organization access is rejected before any service call
  for all five endpoints (7-case suite, including the new filter shapes).

## E. Test Results

- Full suite (`pnpm vitest run`): 345/346 files passed; 3353 passed, 3
  skipped, 1 failed. The sole failure is the pre-existing env-gated live-API
  test (`livePausedAccountCheck.test.ts`, needs `DATAFORSEO_API_KEY`);
  identical to the phases 7-8 baselines.
- New/updated targeted suites: `OpportunityService.test.ts` (16, +8 spec-021
  tests), `opportunityEvidenceLoop.test.ts` (3),
  `opportunities.authorization.test.ts` (7, +3), `OpportunityRepository.test.ts`,
  `FindingService.test.ts`, `InsightComposer.test.ts`, `materializeFinding.test.ts`,
  `OpportunityMaterializer.test.ts`, `intelligence-boundaries.test.ts`,
  `AutopilotService.test.ts` (time-bomb fix), `schema-parity.test.ts` — all
  green; the intelligence + autopilot feature suites pass 379 tests across 46
  files.
- `pnpm types:check`: clean.
- `pnpm lint` (`oxlint . --type-aware`): 0 warnings, 0 errors on 1352 files.
- `pnpm knip`: no findings from this phase after un-exporting four
  internal-only symbols; the remaining unused files/exports are pre-existing
  baseline findings (now one fewer: `throttleit` is declared).
- Prettier: all changed files formatted (`--check` clean on every phase-9
  file); repo-wide `--check .` remains CRLF-blocked on Windows checkouts
  (pre-existing, logged in `.agents/PAPERCUTS.md`).
- `pnpm build` (client + SSR + `tsc`): green.
- Playwright: not re-run — the section reuses existing card/list patterns and
  renders from seeded rows in unit-covered reads; no new route.

## F. Cost & Security Review

- No new paid provider, no new provider call, no background job; the snapshot
  and evidence loop are bounded stored reads/writes.
- The snapshot is one stored read per dashboard load (the list service reads
  the same rows); the evidence loop appends at most one event per referenced
  occurrence per run.
- Project scoping: every endpoint resolves the project through
  `requireProjectContext`; the evidence loop appends by stored occurrence id
  only; no cross-project reads exist.
- The migration adds two nullable columns — existing rows and all existing
  queries are unaffected (parity suite green).
- No secrets or credentials were added; the tests use synthetic rows.

## G. Remaining Risks & Next Steps

1. **Migration numbering collision**: phase 8 (`feat/p1-ai-citation-gaps`,
   unmerged) also introduces migration `0071`/`0049` (ai_search observations).
   Whichever branch merges second renumbers mechanically (file rename + journal
   tag + test bootstrap reference).
2. The view priors (7-day recent window, cap of 8) are module constants; the
   filter window is caller-injected per request. First production usage may
   recalibrate them.
3. Evidence events are appended at run completion (outcome `completed`)
   only; a run that fails after consuming opportunities does not yet write
   failure evidence — a documented future extension.
4. Assignee is a free-form label; there is no user directory or assignment
   notification yet.
5. `throttleit` and the time-bomb fixes are baseline repairs that both this
   branch and the phase-8 branch will want at merge time — trivially
   resolvable but worth flagging to the integrator.