# Implementation Plan: Reports Share and PDF Hardening

**Branch**: `005-reports-share-hardening` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-reports-share-hardening/spec.md`

## Summary

Harden existing sharing/export around the frozen immutable report model: hash-only share tokens
(single display, immediate revoke, opt-in expiry with fail-closed semantics and invalid/revoked/expired
distinction), report activity events (incl. PDF export), public-route credential isolation with leak-audit
test, validated R2 logos, and separate organization-branding + project-client-profile storage frozen into
each report. Raw tokens are never persisted anywhere, including future schedule records (G7).

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `tsc --noEmit` gated)

**Primary Dependencies**: TanStack Start server functions + public route, `ReportService`, `ShareService`,
`BrandingService`, `ExportService`, R2 (`branding/` prefix), better-auth session/project context, Zod

**Storage**: D1 + PG mirror — `report_shares` (token hash UNIQUE), `report_events`, `organization_branding`
(UNIQUE org), `project_client_profiles` (UNIQUE project, cascade); additive migrations + parity tests

**Testing**: Vitest (token lifecycle, revoke-immediacy, expiry fail-closed, leak audit, branding freeze,
logo validation), Playwright public-route spec, `pnpm ci:check`

**Target Platform**: Cloudflare Workers + R2 + Docker self-host

**Project Type**: Web application (existing monorepo)

**Performance Goals**: Share create/revoke/view are single-row operations; public route serves frozen payload
with no computation over live data

**Constraints**: Hash-only tokens, never raw (P32/G7); immutable reports untouched (P31); public route is a
separate trust boundary (P40); credentials never logged/traced (P38); project scope enforced (P39)

**Scale/Scope**: Hardening of existing share/export/branding paths; no report-model or scheduler changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- P31 (immutable snapshots): PASS — FR-007, hardening wraps only.
- P32/G7 (hash-only tokens): PASS — FR-001 incl. never-on-schedules rule + storage inspection test.
- P33 (idempotent schedules): N/A — no scheduler built here; only the no-raw-token constraint recorded.
- P40 (public trust boundary): PASS — FR-003 + automated leak audit.
- P38/P39 (credentials, scoping): PASS — isolation + project checks on all mutating fns.
- P41 (trace): PASS — share/export events traced without secrets.
- P50: PASS — no new report types, no scheduler, no email.
- No violations.

## Project Structure

### Documentation (this feature)

```text
specs/005-reports-share-hardening/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── share-api.md     # share lifecycle + public payload contract
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── server/features/reports/services/
│   ├── ShareService.ts      # hash lifecycle, revoke, expiry
│   ├── BrandingService.ts   # org + client profile, R2 logos
│   ├── ReportService.ts     # branding freeze, events (extend)
│   └── ExportService.ts     # exported-PDF event (extend)
├── serverFunctions/reports.ts
├── routes/r/$token.tsx      # public route (harden, no shell/nav)
└── db/reports.schema.ts + pg mirror (+ branding/client tables)

drizzle/ + drizzle-pg/       # additive migration
tests: colocated + e2e public-share spec
```

**Structure Decision**: Existing reports feature layout; branding split into two tables (not `projects`
columns) per architecture decision.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
