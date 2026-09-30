# Tasks: Email Delivery Infrastructure Spike

**Input**: Design documents from `/specs/009-email-delivery-spike/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/delivery-verdict.md

**Tests**: Included as evidence tooling — env-gated verification harnesses (skip without credentials) + negative-path coverage; the verdict artifact is the deliverable.

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2). US3-style edge handling is folded into the checklist and verdict tasks (the spec has no separate third story — the spike's two stories are verification and recording).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Declare the time-box and baseline before verification begins

- [x] T001 Declare the time-box: record start date + deadline at the top of the working evidence notes (these become the `timeBox` fields of `verdict.md` per `contracts/delivery-verdict.md`); verify baseline green with `pnpm types:check` (no production code changes expected at any point)
- [X] T002 [P] Inventory the current path (evidence baseline, no code changes): document `src/server/email/loops.ts` (transactional send `:38-76`, required env `:14-23`, signup skip-with-warning `:88-98`) and `src/server/email/loops-client.ts` (contacts `:22-54`) exactly as research.md Decision 1 records them, noting the gaps the spike must close (no transient/permanent classification, no retry, no duplicate-send protection today)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The evidence-harness scaffolding the verification stories consume

**⚠️ CRITICAL**: No verification story can begin until this phase is complete

- [x] T003 Create the env-gated verification harness pattern: a Vitest suite (e.g. `src/server/email/loops.spike.test.ts`) that SKIPS cleanly without spike env vars (test recipient address, spike template reference, Loops key access) and asserts only against test recipients with clearly labeled test content — never real client emails (FR-005 secret-free: no keys, no recipient addresses in recorded evidence; follow the scrubbing precedent of `extractSafeRequestMetadata`/`sanitizeDataforseoMessage`)

**Checkpoint**: Foundation ready — harness skips green without env, runs only with explicit test configuration

---

## Phase 3: User Story 1 - Record an evidence-backed verdict (Priority: P1) ⭐ MVP

**Goal**: Every checklist item verified from Worker scheduled context and the verdict recorded — the sole deliverable

**Independent Test**: `specs/009-email-delivery-spike/verdict.md` exists with exactly one verdict value, 100% of checklist items marked observed-with-evidence or not-verified-with-reason, zero unbacked assertions, zero secrets

### Verification for User Story 1

- [x] T004 [P] [US1] Verify quota and rate limits (checklist item `quota_limits`): observe send behavior at scheduled-report MVP cadence (weekly/monthly per project volume assumptions) from Worker scheduled context (`src/server.ts:194-197` plumbing — via the harness, never production code); record observed limits with method + detail
- [x] T005 [P] [US1] Verify sender identity (checklist item `sender_identity`): confirm the from/reply configuration Loops uses for transactional sends, ownership by this deployment, and any per-deployment customization limits; record with method + detail
- [x] T006 [P] [US1] Verify transactional template ownership (checklist item `template_ownership`): confirm a scheduled-report-suitable template can be created/owned/configured by this deployment (distinct from the auth templates `LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID`/`LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID`), and record what happens on an invalid template reference; record with method + detail

### Recording for User Story 1

- [x] T007 [US1] Write `specs/009-email-delivery-spike/verdict.md` per `contracts/delivery-verdict.md`: exactly one verdict value (`EMAIL_DELIVERY_READY` only if EVERY checklist item is observed-with-evidence; otherwise `EMAIL_DELIVERY_BLOCKED` naming incomplete items), recorded timestamp, declared time-box, full evidence checklist, and any required-prerequisites owned by spec 012

**Checkpoint**: US1 independently testable — the verdict artifact is complete and reads per the contract; spec 012's status resolves from it

---

## Phase 4: User Story 2 - Honest failure and degradation answers (Priority: P2)

**Goal**: Failure classification, duplicate-send behavior, and degradation facts recorded with evidence

**Independent Test**: Each failure/degradation question in the checklist has an observed answer (or explicit not-verified-with-reason counting against READY)

### Verification for User Story 2

- [x] T008 [P] [US2] Verify failure semantics (checklist item `failure_semantics`): inject a send failure (invalid recipient, bad template reference) via the harness; record whether the failure is observable and classifiable transient vs permanent (today `loops.ts:68-76` logs + throws generically — record what scheduled delivery in 012 would need; classification helpers added as evidence tooling only, never production paths)
- [x] T009 [P] [US2] Verify duplicate-send behavior (checklist item `duplicate_send`): attempt a duplicate send of the same logical email; record whether the outcome is duplicate-safe by design or requires idempotency machinery in 012 (with the observed evidence — FR-003 requires this recorded, not solved)
- [x] T010 [P] [US2] Verify missing-credentials/self-hosted degradation (checklist item `missing_credentials_degradation`): record the degradation matrix per mode — hosted (required env present/absent/invalid) vs self-host (`AUTH_MODE` via `isHostedAuthMode`, `src/lib/auth-mode.ts:32`; hosted auth emails hard-require env; signup sync skips with warning `loops.ts:88-98`) — asserting degradation is explicit (logged skip with reason), never a silent no-op that looks sent
- [x] T011 [US2] Fold US2 findings into `verdict.md`: mark the three items with state + method + detail; append any required-prerequisites (e.g. classification, retry, idempotency design) as `RequiredPrerequisite` rows owned by 012 — recorded, never implemented here

**Checkpoint**: All checklist items marked; verdict final

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T012 Run `pnpm types:check && pnpm oxlint` (harness included) and fix any violations in evidence tooling
- [X] T013 Run quickstart.md validation scenarios end-to-end (checklist execution, failure/duplicate observation, verdict recorded, zero production changes — review everything the spike merged: evidence tooling + docs only)
- [X] T014 Update spec status wiring: confirm spec 012's Draft gate reads the verdict (`EMAIL_DELIVERY_READY` unblocks planning; `BLOCKED` keeps it Draft with the recorded reason discoverable)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies — start immediately (T001 declares the box; expiry with unmarked items ⇒ BLOCKED per contract)
- **Phase 2 Foundational**: Depends on T001 — BLOCKS both stories
- **US1 (Phase 3)**: After T003; T004–T006 parallel (independent checklist items); T007 after any of them but final only when ALL items (incl. US2's) are marked
- **US2 (Phase 4)**: After T003; T008–T010 parallel (independent items); T011 folds into the verdict
- **Polish (Phase 5)**: After both stories

### Parallel Opportunities

- T002 parallel with T003 (inventory vs harness)
- T004, T005, T006 fully parallel (distinct checklist items)
- T008, T009, T010 fully parallel (distinct failure modes)

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 → T003 → T004–T006 → T007 (with any US2 items still open ⇒ BLOCKED honestly)
2. The verdict IS the product; a BLOCKED verdict recorded honestly is a successful spike

### Incremental Delivery

US1 (quota/sender/template + verdict) → US2 (failure/duplicate/degradation folded in) → Polish (zero-production-changes review + 012 gate wiring) — each verifiable via quickstart scenarios 1–2, 3–4.

## Notes

- Zero production behavior changes: no delivery code paths, no provider changes, no altered email flows, no scheduled-send code (FR-004/P50) — T013 reviews the merged diff against exactly this list.
- Test recipients only; secrets and real addresses never recorded (FR-005/P38/P41).
- Time-box expiry with unmarked items ⇒ `EMAIL_DELIVERY_BLOCKED` with the incomplete items named — the honest default is the feature's core guarantee (P46).
