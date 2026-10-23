# Feature Specification: Schema Generator (structured data observed-only generator + editor)

**Feature Branch**: `016-schema-generator`

**Created**: 2026-10-23

**Status**: Implemented - Phase 4 delivered 2026-10-23: observed-only generator (12 types), two-axis validation, existing-vs-proposed diff, `schema_gap` detector, project-scoped service/server function, read-only MCP `get_page_schema`, and the audit editor UI (preview/copy/export). Unit suites, `tsc`, Prettier, oxlint, and knip are clean; Playwright `audit-schema-editor` is 2/2. The full suite has one pre-existing env-gated live-API failure; `pnpm build` (client + SSR + `tsc`) is green after the eager-boundary fix (see `docs/plans/reports/2026-10-23-schema-generator-phase4-verification.md`).

**Input**: User description: "Phase 4 of the P1 SEO Intelligence master plan (`docs/plans/2026-10-17-p1-seo-intelligence-implementation.md` §3.2 row 4): `src/server/lib/schema/` extractors/validators/generator (observed-only property policy — never fabricate reviews/ratings/prices/addresses/authors); per-type coverage (Organization, LocalBusiness, Article, BlogPosting, Product, BreadcrumbList, FAQPage, WebSite, WebPage, Service, Person, Event); validity vs Google rich-result eligibility distinction; existing-vs-proposed diff; audit issues; server functions + editor UI (preview/copy/export); `schema_gap` detector; MCP tool; fabrication-guard tests."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Generate JSON-LD from what the page actually shows (Priority: P1)

A project owner opens a crawled page and asks for schema markup. The product returns a proposed JSON-LD document built only from values the audit actually observed on that page (title, headings, breadcrumb trail, visible price/currency/availability, images with alts, publish/modified dates, canonical URL) — every property carries its observation source. Properties with no observed value are omitted, never defaulted, never guessed.

**Why this priority**: The observed-only policy is the reason the feature exists; shipping a generator that fills gaps would institutionalize fabricated structured data.

**Independent Test**: Run the generator against the sparse product fixture; assert the proposed document contains only observed properties (null currency/availability omitted), and every emitted property maps to a stored page field or parsed JSON-LD/microdata source.

**Acceptance Scenarios**:

1. **Given** a `STATIC_COMPLETE` product page with observed price and currency, **When** the generator runs, **Then** the Product schema includes `offers.price` + `offers.priceCurrency` sourced from the page, with no invented values.
2. **Given** a `STATIC_COMPLETE` product page with an unobservable price, **When** the generator runs, **Then** no price/currency property is emitted and the validation report explains the omission.
3. **Given** a page whose extraction state is not `STATIC_COMPLETE` (blocked, failed, `RENDERING_REQUIRED`), **When** the generator is requested, **Then** it refuses to propose a document and reports the reason (uncertainty is reported, never papered over).

### User Story 2 - Know whether the markup is valid vs rich-result eligible (Priority: P1)

Every proposed document is validated on two axes: Schema.org structural validity (required properties per type) and Google rich-result eligibility (required + recommended properties per supported feature), reported separately so users understand "valid but won't earn a rich result".

**Independent Test**: Fixture corpus of valid, invalid, and valid-but-ineligible documents; assert distinct outcomes per axis.

**Acceptance Scenarios**:

1. **Given** a complete Product document, **When** validated, **Then** it reports `valid: true` and `richResultEligible: true` with the missing-recommended list empty.
2. **Given** a document missing `offers.price`, **When** validated, **Then** it reports `valid: true`, `richResultEligible: false`, and names the missing required rich-result properties.

### User Story 3 - See what changes versus what the page already has (Priority: P2)

The editor shows an existing-vs-proposed diff: properties already present (kept), properties that would change value (with old/new and source), and new properties. Conflicting existing values are flagged, never silently overwritten.

**Acceptance Scenarios**:

1. **Given** a page already publishing Product JSON-LD with a stale price, **When** the diff is computed, **Then** the price change is shown as `changed` with both values and observation sources, and applying requires explicit confirmation.
2. **Given** an existing schema/canonical conflict, **When** the diff is computed, **Then** it is flagged as a conflict, not resolved silently.

### User Story 4 - Schema gap detector and MCP access (Priority: P2)

The audit surfaces a `schema_gap` insight/opportunity for `STATIC_COMPLETE` pages lacking eligible schema (or missing required properties), and MCP exposes a read-only tool to fetch the proposed document and validation report for a page.

**Acceptance Scenarios**:

1. **Given** a completed audit where a page has no structured data, **When** the detector runs, **Then** it emits a `schema_gap` finding with page evidence and the supported type candidates.
2. **Given** the MCP tool, **When** invoked for a page, **Then** it returns the proposed JSON-LD, validity/eligibility report, and diff summary — and never writes.

### Edge Cases

- Multi-block JSON-LD / `@graph` inputs (multiple existing documents): per-block diff, no cross-block merging that loses provenance.
- Conflicting observed values (meta title vs heading vs JSON-LD name): pick by documented precedence, surface the conflict in the report.
- Pages with observed addresses/authors only in body text (no structure): out of scope — never inferred into LocalBusiness/Person properties.
- FAQPage: only observed question/answer pairs; no generated questions.
- Event: only observed dates; no inferred occurrences.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The generator MUST support Organization, LocalBusiness, Article, BlogPosting, Product, BreadcrumbList, FAQPage, WebSite, WebPage, Service, Person, and Event.
- **FR-002**: Every emitted property MUST carry an observation source (stored page field, parsed JSON-LD/microdata path, or DOM evidence). Values without an observed source are omitted.
- **FR-003**: The system MUST NEVER fabricate reviews, ratings, prices, currencies, availability, addresses, authors, or dates (D6/D12 rules from the crawler milestone).
- **FR-004**: Validation MUST distinguish Schema.org structural validity from Google rich-result eligibility, per supported type/feature.
- **FR-005**: The diff MUST classify each property as kept / added / changed / conflicting, with old and new values and sources.
- **FR-006**: Generation MUST be gated on `STATIC_COMPLETE` extraction; other states yield an explanatory refusal, not partial documents.
- **FR-007**: A `schema_gap` detector MUST emit gated audit findings for eligible pages missing schema or required properties, reusing the existing issue pipeline semantics.
- **FR-008**: Server functions MUST follow server function → service → repository, with project scoping and authorization tests (`*.authorization.test.ts`).
- **FR-009**: A read-only MCP tool MUST return proposal + validation + diff for a page.
- **FR-010**: Editor UI MUST provide preview, copy, export (JSON-LD), and the diff view with explicit confirmation for changed values.

### Non-Functional Requirements

- **NFR-001**: No new paid providers; no network calls beyond stored audit state.
- **NFR-002**: Reuse existing schema data already persisted per page (`audit_pages.structured_data_json`, extraction columns) — no parallel extraction pass.
- **NFR-003**: Bounded output: generated documents capped (e.g. ≤ 100 KB) and deterministic for identical inputs.
- **NFR-004**: All proposals must be JSON-serializable and stable across runs (no timestamps unless observed).

### Key Entities

- **SchemaProposal**: type, properties with sources, generated JSON-LD, validation report, gate state.
- **ValidationReport**: `valid`, `richResultEligible`, missing/recommended lists, per-property notes.
- **SchemaDiff**: per-property classification (kept/added/changed/conflicting) with sources.
- **SchemaGapFinding**: page, candidate types, missing requirements, evidence refs.

## Success Criteria _(mandatory)_

- **SC-001**: Sparse/blocked/rendering-required fixtures never produce fabricated properties (fabrication-guard tests green).
- **SC-002**: All 12 supported types produce valid documents on their fixture pages and report eligibility correctly.
- **SC-003**: `schema_gap` findings appear only for `STATIC_COMPLETE` pages and never duplicate existing `schema-invalid` issues.
- **SC-004**: Full suite, oxlint, prettier, tsc, schema parity, and `ci:check` green.
- **SC-005**: E2E coverage for the editor flow (open page → propose → diff → copy/export).

## Assumptions

- The crawler milestone (Phases 1–3, branch `feat/p1-crawler-hardening`) is the verified baseline; this feature branches from its HEAD.
- `audit_pages.structured_data_json` and the extraction-state columns shipped in migrations 0064–0068 are the input inventory.
- Rich-result eligibility rules are encoded as a checked-in matrix with citations; they are versioned code, not runtime lookups.
