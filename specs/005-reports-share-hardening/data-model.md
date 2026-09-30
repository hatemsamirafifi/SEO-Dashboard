# Data Model: Reports Share and PDF Hardening

**Feature**: `005-reports-share-hardening` | **Date**: 2026-09-28

Persisted tables (D1 + PG mirror, additive migration). Conventions: `id TEXT PK`, ISO-text timestamps,
project-leading indexes, writes via `executeInBatches`.

## ReportShare (`report_shares`)

| Field | Type | Rules |
|---|---|---|
| id | text PK | Share reference ID (schedules store this, never tokens) |
| reportId | text FK→reports cascade | — |
| projectId / organizationId | text | Scoping |
| tokenHash | text UNIQUE | SHA-256 of 256-bit token; raw token never stored |
| expiresAt | ISO text \| null | Null = no expiry (default); opt-in at creation only |
| revokedAt | ISO text \| null | Set on revoke; effective immediately |
| viewCount | integer | Incremented on public views |
| createdAt | ISO text | — |

**State**: `active (revokedAt null AND (expiresAt null OR now < expiresAt)) | revoked | expired`.
Public resolution order: unknown hash → invalid; revoked → revoked; expired → expired; else content.

## ReportEvent (`report_events`, extended)

| Field | Type | Rules |
|---|---|---|
| id | text PK | — |
| reportId | text FK cascade | — |
| action | enum | created \| shared \| revoked \| viewed \| exported_pdf (extended set) |
| actorRef | text \| null | Minimal actor reference; no unnecessary PII |
| createdAt | ISO text | — |

## OrganizationBranding (`organization_branding`)

| Field | Type | Rules |
|---|---|---|
| organizationId | text UNIQUE | 1:1 org identity |
| agencyName / agencyLogoR2Key / accentColor / footerText | validated | Colors from allowlist; footer plain text; logo validated MIME/size/dims |

## ProjectClientProfile (`project_client_profiles`)

| Field | Type | Rules |
|---|---|---|
| projectId | text UNIQUE FK→projects cascade | 1:1 client identity |
| clientName / clientLogoR2Key / reportTitleOverride / notes | validated/nullable | Same upload validation as branding |

## BrandingSnapshot (embedded in report payload, not a table)

Frozen `{agency: {...}, client: {...}}` resolved at generation; later branding edits never mutate it.

## Relationships

`reports 1—* shares`; `reports 1—* events`; org `1—1` branding; project `1—1` client profile.
Public route resolves share by `tokenHash` only.
