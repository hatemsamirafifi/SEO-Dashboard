# Research: Reports Share and PDF Hardening

**Feature**: `005-reports-share-hardening` | **Date**: 2026-09-28

All unknowns resolved via spec clarification (2026-09-28) + repository discovery. No open NEEDS CLARIFICATION.

## Decision 1: Token storage

- **Decision**: 256-bit token, SHA-256 hash stored (`token_hash` UNIQUE), raw shown once; never persisted —
  including never on `report_schedules` (share reference by ID only, forward constraint for 012).
- **Rationale**: Constitutional P32/G7; single-display + hash-only is the standard share-link pattern.
- **Alternatives considered**: Encrypted-raw storage (rejected: retrievable raw = persistently exposed);
  JWT-style stateless tokens (rejected: revocation needs server state).

## Decision 2: Expiry default

- **Decision**: No expiry by default; opt-in `expiresAt` at creation, editable only via approved
  share-management flow. Expired links fail closed; public responses distinguish invalid / revoked /
  expired without leaking internals.
- **Rationale**: Clarified 2026-09-28; preserves current sharing expectations, backward compatible.
- **Alternatives considered**: 7/30-day default expiry (rejected: silently breaks long-lived client links).

## Decision 3: Branding split

- **Decision**: `organization_branding` (UNIQUE organizationId) + `project_client_profiles` (UNIQUE
  projectId, cascade) as dedicated tables; generation freezes the resolved combination into the report
  snapshot; logos validated (MIME/size/dimensions) under R2 `branding/` prefix.
- **Rationale**: Avoids widening the hot `projects` table + parity churn; frozen snapshot keeps history
  stable across branding edits.
- **Alternatives considered**: Columns on `projects` (rejected: join/parity cost); live branding references
  (rejected: history mutates when branding changes).

## Decision 4: Public-route isolation

- **Decision**: `r/$token` outside the authenticated shell (no nav/session), token-hash lookup only,
  sanitized payload incl. consistency banner, no credentials/costs/internal payloads; leak-audit test
  asserts the allowlist.
- **Rationale**: Constitutional P40; allowlist assertion beats denylist for leak prevention.
- **Alternatives considered**: Reusing the in-app report renderer (rejected: shell/nav/session leakage surface).
