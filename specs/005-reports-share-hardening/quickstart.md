# Quickstart: Reports Share and PDF Hardening

**Feature**: `005-reports-share-hardening` | **Date**: 2026-09-28

Validation guide. See [spec](spec.md), [contract](contracts/share-api.md).

## Prerequisites

- Local dev stack with R2 (or R2 emulator) for logo storage; test project + generated report;
  both DB backends for parity; `pnpm types:check`, `pnpm oxlint` green.

## Scenarios

### 1. Share lifecycle (create → view → revoke)

1. Create a share with 30-day expiry; copy the once-displayed token; reload — token unrecoverable.
2. Open the URL anonymously → report renders with branding + consistency banner.
3. Revoke; reopen the URL within one minute.
4. **Expect**: dead link (`revoked` state); in-app report untouched; events recorded.

### 2. Expiry + fail-closed states

1. Create shares: no-expiry, expired, and invalid-token URLs.
2. **Expect**: no-expiry link works; expired shows `expired` with zero content; unknown hash shows
   `invalid`; all three distinguishable without internal leakage.

### 3. Leak audit + storage inspection

1. Fetch the public payload; assert the allowlist (sections + branding + banner) and the absence of
   credentials, costs, internal payloads, raw tokens, cross-project data.
2. Inspect storage for raw tokens (all tables, logs).
3. **Expect**: leak-audit test green; zero raw tokens anywhere — hashes only.

### 4. Branding freeze

1. Set org branding + client profile; generate report A; change branding; generate report B.
2. **Expect**: A renders old branding, B renders new; logo uploads reject bad MIME/oversize.

## Commands

```bash
pnpm types:check && pnpm oxlint
pnpm test ShareService BrandingService ReportService ExportService schema-parity
pnpm test:e2e public-share   # public-route spec; record follow-up if absent
```
