# Quickstart: Email Delivery Infrastructure Spike

**Feature**: `009-email-delivery-spike` | **Date**: 2026-09-30

Validation guide — runs the spike and records the verdict. See [spec](spec.md), [contract](contracts/delivery-verdict.md).

## Prerequisites

- Declare the time-box and deadline up front; Loops test credentials available to the runner; test-only recipient addresses; typecheck/lint green (`pnpm types:check`, `pnpm oxlint`).

## Scenarios

### 1. Execute the checklist

1. For each checklist item (quota/limits, sender identity, template ownership, failure semantics, duplicate-send, missing-credentials/self-hosted degradation): verify from Worker scheduled context with test recipients only.
2. **Expect**: every item marked observed-with-evidence (method + detail recorded) or not-verified-with-reason. No secrets in any recorded evidence.

### 2. Failure and duplicate behavior observed

1. Inject a send failure (invalid recipient, bad template reference) and attempt a duplicate send of the same logical email.
2. **Expect**: failure is visible and classified (transient vs permanent); duplicate-send behavior is recorded with its implication for 012's idempotency design — neither observation blocks evidence recording.

### 3. Record the verdict

1. Write `specs/009-email-delivery-spike/verdict.md` with exactly one verdict value, timestamp, time-box, full checklist, and any required-prerequisites.
2. **Expect**: `EMAIL_DELIVERY_READY` only if every item is observed-with-evidence; otherwise `EMAIL_DELIVERY_BLOCKED` naming the incomplete items. Spec 012's status resolves from the verdict.

### 4. Zero production changes

1. Review everything the spike run merged.
2. **Expect**: evidence tooling and documentation only — no delivery code paths, no provider changes, no altered email flows, no scheduled-send code.

## Commands

```bash
pnpm types:check && pnpm oxlint
# env-gated verification harnesses per tasks.md (skip without credentials)
```
