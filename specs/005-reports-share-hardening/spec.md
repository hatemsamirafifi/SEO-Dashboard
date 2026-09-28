# Feature Specification: Reports Share and PDF Hardening

**Feature Branch**: `005-reports-share-hardening`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Harden existing report sharing and PDF export: hash-only share tokens (raw token shown once, never persisted — never on report_schedules), revoke, optional expiry, report events incl. exported-PDF event, public-page credential isolation, R2-backed logos, project client profile. Implements Track D milestone D1 of the Final Revised Implementation Plan (PR14). Immutable report snapshot model is frozen and untouched."

## Clarifications

### Session 2026-09-28

- Q: Do new share links expire by default? → A: No expiry by default; expiry is opt-in at creation via an optional expiresAt value, editable only through the approved share-management flow. Links stay valid until explicitly revoked or the optional expiry is reached — no silent default lifetime. Expired links fail closed without exposing content, revocation takes effect immediately regardless of expiry, and public responses distinguish invalid / revoked / expired without leaking internal details.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Share a report link with expiry and revoke (Priority: P1)

An agency owner generates a client report, creates a share link with an optional expiry date, sends it to
the client, and later revokes it. The raw token is shown exactly once at creation; afterwards only the
hash exists in storage. Revocation takes effect immediately.

**Why this priority**: Share-link lifecycle (create → view → revoke/expiry) is the core D1 agency workflow.

**Independent Test**: Can be fully tested by creating a share, viewing it publicly, revoking it, and
verifying the link dies while the underlying report is untouched.

**Acceptance Scenarios**:

1. **Given** a generated report, **When** the owner creates a share link with a 30-day expiry,
   **Then** the raw token is displayed once, only its hash is stored, and the link works until expiry
   or revocation.
2. **Given** an active share link, **When** the owner revokes it, **Then** the public URL stops working
   immediately while the report itself remains available in-app.

---

### User Story 2 - View a shared report safely without login (Priority: P2)

A client opens the public share URL with no account and sees the frozen report (including any
consistency banner) with agency/client branding — but no credentials, no cost data, no internal payloads,
and no access to any other project data.

**Why this priority**: The public route is a separate trust boundary; a leak here is a security incident.

**Independent Test**: Can be tested by fetching the public URL as an anonymous user and asserting the
payload contains only shareable report data plus branding, with zero credential/cost/internal fields.

**Acceptance Scenarios**:

1. **Given** a valid share link, **When** an anonymous visitor opens it,
   **Then** they see the frozen report content with branding and consistency state, and nothing else.
2. **Given** a revoked or expired share link, **When** a visitor opens it,
   **Then** they see an invalid-link notice with no report content.

---

### User Story 3 - Brand reports and audit report activity (Priority: P3)

The owner sets organization branding (name, logo, accent, footer) and a per-project client profile
(client name, logo, title override); generated reports freeze the resolved combination. Report activity
(created, shared, revoked, viewed, exported PDF) is recorded in an audit trail.

**Why this priority**: White-label agency reporting plus an audit trail completes D1; independently
testable from sharing mechanics.

**Independent Test**: Can be tested by setting branding + client profile, generating a report, exporting
PDF, and verifying the frozen branding snapshot and the activity events.

**Acceptance Scenarios**:

1. **Given** organization branding and a project client profile, **When** a report is generated,
   **Then** the report freezes that exact branding combination, unaffected by later branding edits.
2. **Given** report activity (generate, share, view, export PDF, revoke), **When** the owner reviews
   the audit trail, **Then** each action appears with its timestamp and no personal data beyond what is
   necessary.

---

### Edge Cases

- What happens if the share-creation response is lost before the owner copies the token? The raw token
  cannot be re-displayed (hash-only storage); the owner creates a new share and revokes the lost one.
- What happens when a schedule later references a share? It stores a share reference (ID), never the raw
  token — enforced by test.
- What happens to existing shares when branding changes? Nothing — generated reports carry frozen branding
  snapshots; only future reports use the new branding.
- What happens when a logo upload is malicious (wrong MIME, huge file)? Upload validation rejects it with
  a clear error; nothing is stored.
- What happens when the PDF export fails? The report remains available; the failure is recorded and
  surfaced with a retry option — the report content is never half-generated.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Share tokens MUST be stored as hashes only. The raw token MUST be shown/usable exactly once
  at creation and MUST NEVER be persisted — including never on any report schedule record.
- **FR-002**: Shares MUST support revocation (immediate effect regardless of expiry) and opt-in expiry
  (an optional expiresAt set at creation, editable only through the approved share-management flow).
  No default lifetime is applied silently. Expired links MUST fail closed without exposing report content,
  and public responses MUST distinguish invalid token, revoked link, and expired link without leaking
  sensitive internal details.
- **FR-003**: The public share route MUST expose only explicitly shareable report data plus frozen branding.
  Credentials, cost data, internal provider payloads, raw tokens, and unrelated project data MUST NOT be
  exposed (verified by a leak audit test).
- **FR-004**: Report activity MUST be recorded as events: created, shared, revoked, viewed, exported PDF —
  without unnecessary personal data.
- **FR-005**: Organization branding (name, logo, accent color, footer) and per-project client profiles
  (client name, logo, title override, notes) MUST be stored separately from core project records and frozen
  into each generated report at generation time.
- **FR-006**: Logo uploads MUST be validated (type, size, dimensions) and stored in object storage; the
  public page serves only the validated asset.
- **FR-007**: The immutable report snapshot model (frozen payload, provenance, consistency state) MUST NOT
  be altered by this feature; hardening only wraps it.

### Key Entities

- **ReportShare**: One share link; attributes include report reference, token hash, creation/expiry/
  revocation timestamps, and view counts.
- **BrandingSnapshot**: The frozen agency + client branding combination embedded in a report at generation.
- **ReportEvent**: One audit entry for report activity; attributes include report reference, action type,
  and timestamp.
- **ClientProfile**: Per-project client identity used for white-label rendering.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An owner can create a share link, view it anonymously, revoke it, and confirm the revoked
  link is dead within one minute while the report remains intact in-app.
- **SC-002**: An automated leak audit of the public route finds zero credential, cost, internal-payload,
  raw-token, or cross-project fields in the response.
- **SC-003**: A storage inspection finds zero raw share tokens anywhere (including schedule-related records);
  only hashes exist.
- **SC-004**: A report generated before a branding change still renders the old branding, while a report
  generated after renders the new branding.

## Assumptions

- The five report types, section selectors, payload schema, and dual-sided provenance behavior are frozen
  inputs; this feature does not change what a report contains.
- PDF export reuses the existing export path; vendor/async improvements belong to a later package.
- Scheduled/email report delivery is explicitly out of scope (separate conditional packages); the only
  scheduling-related rule here is the never-persist-raw-tokens constraint.
- The public route lives outside the authenticated app shell with no navigation or session context.
