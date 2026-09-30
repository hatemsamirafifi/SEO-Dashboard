# Research: Email Delivery Infrastructure Spike

**Feature**: `009-email-delivery-spike` | **Date**: 2026-09-30

All unknowns resolved via spec (binary output, honest-default rules) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Current email path inventory (verified in code)

- **Decision**: The existing path is Loops-only: `src/server/email/loops.ts` sends transactional mail via `https://app.loops.so/api/v1/transactional` (Bearer `LOOPS_API_KEY`, `addToAudience: false`, string `dataVariables`; `:38-76`); `loops-client.ts` manages contacts via `contacts/update` PUT (`:22-54`) plus name-part helpers. Live today: signup contact sync (skips with warning when no key, `loops.ts:88-98`), verification email and password-reset email (required env `LOOPS_API_KEY` + `LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID` / `LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID`, `:14-23`). Failure behavior today: any non-OK send logs status + payload and throws a generic error (`:68-76`) — no transient/permanent classification, no retry, no idempotency. Contact updates throw generically (`loops-client.ts:40-54`).
- **Rationale**: This inventory IS the spike's checklist baseline — quota, sender ownership, template control, failure classification, and duplicate-send behavior are all unverified today (the gaps are the spike).
- **Alternatives considered**: Treating auth-email success as proof of scheduled-report readiness (rejected: different template, different volume, different failure tolerance — G6 exists precisely because the proof doesn't transfer).

## Decision 2: Hosted/self-host degradation facts

- **Decision**: Mode is governed by `AUTH_MODE` via `isHostedAuthMode` (`src/lib/auth-mode.ts:32`). Hosted auth emails hard-require env (`loops.ts:14-23`); signup sync degrades to a logged skip without a key (`:88-98`); self-host auth paths avoid the hosted email functions (`src/lib/auth.ts:227`). The spike records the degradation matrix per mode: what happens on missing key, invalid key, and unprovisioned account — in both modes.
- **Rationale**: Scheduled reports must degrade honestly on self-host (G9-adjacent product rule: failure is explicit, never a silent no-op that looks sent). The existing skip/throw split is the precedent to verify against.
- **Alternatives considered**: Hosted-only verification (rejected: self-hosted degradation is an explicit checklist item in the spec).

## Decision 3: Scheduled infrastructure the spike verifies against

- **Decision**: Scheduled work runs from the server scheduled entry (`src/server.ts:194-197` → `runScheduledRankChecks` / `runScheduledGscSync` / `runScheduledGa4Sync` / `runScheduledIntelligenceScan`). Spec 012 will add a scheduled-reports runner there; this spike verifies only that email sends work from Worker scheduled context (external fetch to Loops, timeouts, env availability) using the existing plumbing — via test sends, never production code.
- **Rationale**: The delivery question is "can the existing path carry scheduled sends", not "build the scheduler" (that is 012). Verifying from the same context removes a whole class of later surprises (egress, timeouts, secret access).
- **Alternatives considered**: Verifying only from ad-hoc scripts outside scheduled context (rejected: would leave the Worker-context question open — the exact thing G6 must close).

## Decision 4: Verdict artifact and 012 gate wiring

- **Decision**: The verdict lives at `specs/009-email-delivery-spike/verdict.md` (house spec-dir convention) with status + evidence summary; the spec's own status line reflects the verdict. Spec 012's planning precondition is "verdict.md exists with EMAIL_DELIVERY_READY"; BLOCKED keeps 012 Draft (spec FR-006).
- **Rationale**: Spec-scoped artifacts belong with the spike package (plan §3: "verdict recorded"); a file the plan commands and humans can both read beats tribal knowledge. House precedent: 003's discovery artifacts live in its spec dir.
- **Alternatives considered**: Verdict in `docs/` or memory files (rejected: cross-cutting docs dilute the gate; the 012 gate needs a single authoritative location).

## Decision 5: Evidence harness conventions

- **Decision**: Verification runs env-gated (test recipients only, clearly labeled test content), records observation method per claim (live test / log excerpt / documented provider behavior), and keeps all evidence secret-free — following the house secret-scrubbing patterns (`extractSafeRequestMetadata`/`sanitizeDataforseoMessage` in the envelope code as the scrubbing precedent; trace must never carry secrets per P38/P41).
- **Rationale**: Matches the spec's FR-005 and the Constitution's credential rules; env-gating matches existing live-test conventions (tests that skip without credentials).
- **Alternatives considered**: Merging throwaway harnesses into production services (rejected: FR-004 scope discipline — evidence tooling/docs only).

## Decision 6: Time-box and honesty defaults

- **Decision**: The time-box and deadline are declared at spike start; expiry with any checklist item unmarked yields BLOCKED (spec edge case) — unverified is never READY. Required-prerequisites discovered (template changes, quota increases, idempotency machinery in 012) are recorded, never implemented here.
- **Rationale**: Already binding in the spec; recorded here so the plan's task list carries the same rule.
- **Alternatives considered**: Extending the box on partial progress (rejected: the honest default is the feature's core guarantee; a later verified attempt is the sanctioned path).
