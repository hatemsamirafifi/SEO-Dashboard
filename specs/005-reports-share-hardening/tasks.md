# Tasks: Reports Share and PDF Hardening

**Input**: Design documents from `/specs/005-reports-share-hardening/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/share-api.md

**Tests**: Included — token lifecycle, leak audit, storage inspection, branding validation (P32/P38/P40).

**Organization**: Tasks grouped by user story (US1 P1 → US2 P2 → US3 P3).

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline before hardening

- [X] T001 Verify baseline green: reports suite (`pnpm test ReportService ShareService BrandingService ExportService`) and `pnpm types:check` on main

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Dual-dialect schema + token-hash primitive all stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 Extend `report_shares` (`tokenHash` UNIQUE, `expiresAt` nullable, `revokedAt`, `viewCount`) in `src/db/reports.schema.ts` + PG mirror with additive migration in `drizzle/` + `drizzle-pg/` and parity coverage
- [X] T003 Add `organization_branding` (UNIQUE org) + `project_client_profiles` (UNIQUE project, cascade) tables in `src/db/reports.schema.ts` + PG mirror, same migration, parity coverage
- [X] T004 [P] Add token-hash helper (256-bit token, SHA-256 hash, single-display flow, never logs raw) in `src/server/features/reports/services/ShareService.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Share link lifecycle (Priority: P1) 🎯 MVP

**Goal**: Create (once-displayed token, opt-in expiry) → view → revoke-immediately, raw never persisted

**Independent Test**: Full lifecycle on a test report; revoked link dead within one minute; in-app report intact

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T005 [P] [US1] Token lifecycle tests (hash-only storage, single display unrecoverable, revoke immediacy, expiry fail-closed) in `src/server/features/reports/services/ShareService.test.ts`

### Implementation for User Story 1

- [X] T006 [US1] Implement create/revoke/expiry in `src/server/features/reports/services/ShareService.ts` (hash lookup, resolution order invalid → revoked → expired → content)
- [X] T007 [US1] Wire `createReportShare`/`revokeReportShare`/`getReportShares` server functions in `src/serverFunctions/reports.ts` (project-scoped)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Safe anonymous viewing (Priority: P2)

**Goal**: Public route exposes allowlisted payload only; invalid/revoked/expired distinguishable; zero raw tokens in storage

**Independent Test**: Anonymous fetch asserts allowlist + denylist; storage inspection finds hashes only

### Tests for User Story 2

- [X] T008 [P] [US2] Leak-audit test (payload allowlist; no credentials/costs/internal payloads/raw tokens/cross-project data) for the public route
- [X] T009 [P] [US2] Storage inspection test (zero raw share tokens in all tables/logs; schedules store share ID only) in reports test suite

### Implementation for User Story 2

- [X] T010 [US2] Harden public route `r/$token` (outside auth shell, no nav/session, hash-only lookup, state distinction, view counting)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Branding + activity audit (Priority: P3)

**Goal**: Org/client branding frozen per report; activity events including PDF export

**Independent Test**: Branding-change freeze check (old vs new report); event trail complete

### Tests for User Story 3

- [X] T011 [P] [US3] Branding validation tests (MIME/size/dimensions rejection) + freeze test (pre-change vs post-change report) in `src/server/features/reports/services/BrandingService.test.ts`

### Implementation for User Story 3

- [X] T012 [US3] Implement org branding + client profile CRUD with R2 `branding/` uploads in `src/server/features/reports/services/BrandingService.ts` (+ `brandLogo.ts` validation)
- [X] T013 [US3] Freeze resolved branding into report snapshot at generation + emit `exported_pdf` event in `src/server/features/reports/services/ReportService.ts` and `src/server/features/reports/services/ExportService.ts`

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: E2E + gates

- [X] T014 Run `pnpm types:check`, `pnpm oxlint`, reports suites, `schema-parity`
- [X] T015 [P] Public-share E2E spec (`e2e/`) + quickstart.md validation scenarios 1–4

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - needs US1 shares to exercise route
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - needs US1 reports flow for freeze check

### Parallel Opportunities

- T004 can run alongside T002/T003; T005 + T008 + T009 + T011 (all test files, parallel-draftable)
- T006/T007 must precede T010 (shares exist before route hardening); T012 before T013

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently (lifecycle + hash-only)
5. Then US2 (trust boundary), then US3 (branding/audit)
