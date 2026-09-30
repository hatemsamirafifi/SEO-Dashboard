# Contract: Report Share Lifecycle + Public Payload

**Feature**: `005-reports-share-hardening` | **Date**: 2026-09-28

Server-function + public-route contract. Raw tokens never cross a storage boundary.

## `createReportShare`

- **Input**: `{ projectId, reportId, expiresAt?: ISODate | null }` — expiry opt-in only, no silent default.
- **Output (once)**: `{ shareId, url, rawToken }`. The raw token is displayed exactly once and is
  unrecoverable afterwards (lost token → create new share, revoke the old).
- **Storage**: `tokenHash = sha256(rawToken)` UNIQUE; `expiresAt` nullable; no raw token in any row,
  log, trace, or schedule reference.

## `revokeReportShare` / expiry

- Revoke sets `revokedAt`; effective immediately regardless of expiry.
- Expiry evaluated per request (`now ≥ expiresAt` → expired); expired links fail closed, zero content.
- Public resolution order: unknown hash → `invalid` → revoked → `revoked` → expired → `expired` →
  else content. States are distinguishable without leaking internals.

## Public route `r/$token`

- Token-hash lookup only; outside authenticated shell (no nav/session); increments `viewCount`.
- **Payload allowlist**: frozen report sections + `brandingSnapshot` + consistency banner. **Denylist**
  (asserted by leak-audit test): credentials, cost data, internal provider payloads, raw tokens,
  unrelated project data, session info.

## `exportReportPdf`

- Emits `exported_pdf` report event; failure surfaces with retry, report untouched, no partial artifact
  served as complete.

## Branding contracts

- `setOrganizationBranding({ agencyName, logo, accentColor (allowlist), footerText (plain) })` —
  logo validated (MIME/size/dimensions) → R2 `branding/` key; 1:1 per organization.
- `setProjectClientProfile({ projectId, clientName, logo, titleOverride?, notes? })` — 1:1 per project,
  cascade on project delete.
- Generation freezes `{ agency, client }` into the report snapshot; later edits affect future reports only.

## Events

`created | shared | revoked | viewed | exported_pdf` per report with timestamps and minimal actor refs.
