# Delivery Verdict: EMAIL_DELIVERY_BLOCKED

**Feature**: `009-email-delivery-spike` | **Date**: 2026-09-30
**Time-box**: 2026-09-30 (single implementation session; declared at spike start)
**Verdict**: `EMAIL_DELIVERY_BLOCKED`

> Unverified ≠ ready. Three of six checklist items cannot be answered without
> live provider access from this environment, so the verdict is BLOCKED with
> the precise unblock conditions below. This is a successful spike: it proves
> exactly what is known, what is unknown, and what a credentialed re-run must
> check — 012 stays Draft until then.

## Evidence checklist

### quota_limits — NOT VERIFIED

- What was observed (documented provider behavior):
  - Loops API baseline: 10 requests/second per team; `429 Too Many Requests`
    with `x-ratelimit-limit` / `x-ratelimit-remaining` headers on exhaustion
    (source: Loops API docs, rate limiting).
  - Email sending: free plans 10 emails/second, paid plans 1,000/second —
    excess QUEUES, never rejects. Free plan: 4,000 emails per 30 days
    (marketing + transactional combined); paid plans have no send cap
    (source: Loops billing docs).
  - Code observation: `sendLoopsTransactionalEmail`
    (`src/server/email/loops.ts:38-76`) sends with no quota awareness, no
    rate-limit header inspection, and no backoff — any quota enforcement
    lives provider-side.
- What is missing (reason): this deployment's plan tier and current usage
  against those limits are unobservable without account credentials. No
  `LOOPS_API_KEY` exists in this environment, and no test sends were made
  (no authorized recipients, no approval for external side effects).
- Unblock: re-run with provisioned credentials; record tier + usage vs the
  projected weekly/monthly scheduled-report volume.

### sender_identity — NOT VERIFIED

- What was observed (code + documented behavior):
  - The transactional payload carries NO sender fields
    (`src/server/email/loops.ts:60-66` — `transactionalId`, `email`,
    `addToAudience`, `dataVariables` only). Sender identity (From/Reply-To)
    is owned by the Loops template/dashboard, optionally dynamic via
    template data variables (source: Loops transactional API docs).
  - Ownership of THIS deployment's sender identity cannot be confirmed from
    code — it lives in the Loops dashboard.
- Unblock: confirm the sending identity and its verification state with
  account access.

### template_ownership — NOT VERIFIED

- What was observed (code):
  - Templates are referenced by ID from env (`LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID`,
    `LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID`); only auth templates exist —
    no scheduled-report template exists in this deployment.
  - The provider documents template listing/published-state endpoints and a
    preview endpoint, so ownership is programmatically verifiable — with
    credentials, which are absent here.
- Unblock: create/verify ownership of a scheduled-report transactional
  template (with the report data variables) and record its ID + published
  state. Note: attachments require a separate Loops support enablement.

### failure_semantics — OBSERVED

- Harness (`src/server/email/loops.spike.test.ts`): sends fail with a
  generic `Failed to send Loops transactional email (<status>)` for 401,
  404, 429, and 500 alike — the path classifies NOTHING (no
  transient/permanent distinction, no retry). Callers cannot tell retryable
  throttling from dead credentials.
- Documented provider behavior: 400 = bad request (e.g. unpublished
  template), 404 = template not found, 409 = idempotency-key reuse, 429 =
  rate-limit with headers; send-rate overages queue rather than fail.
- Failure logs include the recipient email address (`loops.ts:68-73`,
  `loops-client.ts:45-51`) — operational note for 012's log hygiene.

### duplicate_send — OBSERVED

- Harness: two identical sends produce two POSTs with byte-identical bodies
  — no idempotency key is sent, so duplicates are deliverable.
- Documented provider behavior: the transactional endpoint accepts an
  `Idempotency-Key` header (409 on 24h reuse) — the capability exists and
  is unused by the current path.
- Implication recorded for 012 (not implemented here): scheduled sends MUST
  supply idempotency keys derived from the schedule identity.

### missing_credentials_degradation — OBSERVED

- Harness + code paths:
  - Signup contact sync without a key: silent skip with warning, no throw
    (`loops.ts:88-98`).
  - Verification/password-reset sends without config: fail closed throwing
    `<NAME> is required in hosted mode` (`loops.ts:14-23`); never a silent
    no-op that looks sent.
  - Self-hosted mode (`AUTH_MODE`, `src/lib/auth-mode.ts:32`): social email
    paths are hosted-only; without Loops keys, email-dependent auth actions
    throw explicitly. Degradation is honest in all modes.

## Required prerequisites (for 012, recorded — never implemented here)

1. Provision Loops credentials + a scheduled-report transactional template
   (owned, published, with report data variables); re-run the three
   not-verified items above against the live account.
2. Confirm plan tier + usage headroom for scheduled-report volume
   (or accept the free-tier 4,000/30d combined cap explicitly).
3. Design 012's sends with `Idempotency-Key` from the schedule identity
   (provider supports it; current path does not use it).
4. Add transient/permanent failure classification + bounded retry to the
   delivery path 012 builds on (current path throws unclassified errors).
5. Decide log hygiene for recipient addresses in failure logs (currently
   logged in clear).
6. If 012 needs PDF attachments: request Loops support enablement first
   (attachments are allow-listed per account).

## Method note

- Live tests: none executed (no credentials, no authorized recipients).
  The harness's env-gated live checks (`loops.spike.test.ts`, skipped
  3/12 in this run) encode exactly what a credentialed re-run observes.
- Evidence methods used: unit-observed code behavior (mocked fetch +
  controlled env), documented provider behavior (Loops API/billing docs
  fetched 2026-09-30), code-path inspection for degradation. No unbacked
  assertions: every claim above cites its method.
