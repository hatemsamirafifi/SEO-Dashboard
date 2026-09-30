# Implementation Plan: Email Delivery Infrastructure Spike

**Branch**: `009-email-delivery-spike` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/009-email-delivery-spike/spec.md`

## Summary

Run a time-boxed verification spike against the existing Loops transactional email path: quota/rate limits, sender identity, template ownership, failure classification, duplicate-send behavior, and missing-credentials/self-hosted degradation — observed from Worker scheduled context with test recipients only. The sole deliverable is one recorded verdict (`EMAIL_DELIVERY_READY` or `EMAIL_DELIVERY_BLOCKED`) with secret-free evidence at `specs/009-email-delivery-spike/verdict.md`. No production delivery code ships; the verdict gates spec 012.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: Existing email modules only (`src/server/email/loops.ts`, `loops-client.ts`); native `fetch`; Vitest for env-gated verification harnesses

**Storage**: No schema changes. Verdict + evidence persist as spec-dir artifacts (`verdict.md`); no database writes.

**Testing**: Vitest (env-gated live checks that skip without credentials; negative-path unit coverage for classification helpers where added as evidence tooling); `pnpm types:check` + `pnpm oxlint`

**Target Platform**: Cloudflare Workers scheduled context (same context 012 will send from), verified via existing scheduled plumbing

**Project Type**: Time-boxed verification spike inside the existing monorepo (no feature code, no new routes/tables/providers)

**Performance Goals**: N/A (verification only). Quota/rate-limit findings must cover projected scheduled-report volume at MVP weekly/monthly cadence.

**Constraints**: Test recipients only — no real client emails; secrets/keys/addresses never recorded in evidence (P38/P41); existing auth/transactional flows unmodified; no new provider (P6/P50)

**Scale/Scope**: One verdict + one evidence checklist; each checklist item observed-with-evidence or not-verified-with-reason; incomplete at expiry ⇒ BLOCKED

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- P6 (no new provider): PASS — Loops only; no alternative evaluated.
- P32/P38/P40 (tokens/credentials/public boundary): PASS — secret-free evidence; test recipients only.
- P37 (Cloudflare-native execution): PASS — verification runs from existing scheduled context; no new queue/engine.
- P41/P42 (trace/ledgers): PASS — observations recorded in the verdict artifact, not the trace bus; no ledger writes.
- P43–P45 (tests/gates): PASS — env-gated harnesses + negative coverage; types:check + oxlint.
- P46 (truthfulness): PASS — the honest default (unverified ⇒ BLOCKED) is the spec's core rule; no unbacked assertions allowed in evidence.
- P48 (discovery first): PASS — research.md inventories the live email path, modes, and scheduled infra from code.
- P50 (scope discipline): PASS — zero production behavior changes; required-prerequisites recorded for 012, never implemented here.
- G6: DECIDED BY THIS PACKAGE — exactly one recorded verdict; 012 stays Draft unless READY.
- No gate violations.

## Project Structure

### Documentation (this feature)

```text
specs/009-email-delivery-spike/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── delivery-verdict.md
├── verdict.md           # THE deliverable (written by the spike run, NOT by /speckit.plan)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/email/loops.ts            # existing path under verification (verify only)
├── server/email/loops-client.ts     # existing contacts path (verify only)
├── lib/auth-mode.ts                 # hosted/self-host detection (verify only)
├── server.ts                        # scheduled entry plumbing (verify only)
└── **/*.test.ts                     # env-gated verification harnesses (evidence tooling only)
```

**Structure Decision**: The spike reads existing email/scheduled code and writes only the verdict artifact plus evidence tooling/docs. Production email flows and the scheduler are verify-only.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
