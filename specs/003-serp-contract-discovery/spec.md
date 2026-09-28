# Feature Specification: SERP Contract Discovery and Freeze

**Feature Branch**: `003-serp-contract-discovery`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Inspect and document the actual Keyword Research → SERP resolver → DataForSEO/Serper/Zenserp → normalized output code path, then freeze the single normalized SERP snapshot contract (organic results + features: PAA, featured snippet, local pack, images, videos, shopping, news, knowledge graph, sitelinks, related searches) that all downstream UI, detectors, and enrichment work must consume. No second SERP resolver, no provider-specific UI models, no raw provider parsing in UI. Implements Track S milestones S0–S1 of the Final Revised Implementation Plan (PR5) and satisfies hard gate G4."

## Clarifications

### Session 2026-09-28

- Q: What uniquely identifies one SERP snapshot? → A: Logical identity is (keyword, engine, canonical location, language, device, checkedAt) with each dimension canonicalized before key construction and checkedAt as a full ISO observation timestamp (never calendar date alone). Provider is provenance, not identity. A content hash may be stored separately for integrity/dedup/validation but never replaces the logical identity. Project scoping (projectId) is a tenancy dimension on the storage key, not part of observation semantics.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Understand the real SERP pipeline before extending it (Priority: P1)

A maintainer about to build competitive enrichment reads a discovery report that documents the actual
code path for one keyword: which entry points exist, which resolver runs, which providers back it in
which order, how results are normalized, cached, coalesced, cost-tracked, and traced — with file
references to the live code, not to planning documents.

**Why this priority**: Every SERP workstream decision (bulk strategy, cache dimensions, merge identity)
depends on ground truth about what exists. Guessing here creates the second-resolver risk this package
exists to prevent.

**Independent Test**: Can be tested by handing the discovery report to an engineer unfamiliar with the
SERP code and verifying they can trace one keyword end-to-end (entry → provider → normalized output →
cache) using only the report's file references.

**Acceptance Scenarios**:

1. **Given** the discovery report, **When** an engineer traces a keyword SERP fetch,
   **Then** the report correctly identifies the entry functions, resolver, provider order, normalization
   point, cache keys/TTLs, single-flight usage, cost tracking, and trace events as they exist in code.
2. **Given** any discrepancy between prior docs and code, **When** the report is reviewed,
   **Then** the code is recorded as authoritative and the discrepancy is explicitly listed.

---

### User Story 2 - Build all SERP consumers on one frozen contract (Priority: P2)

Engineers building enrichment, SERP features UI, and future detectors code against a single frozen
normalized snapshot shape covering keyword/market context, organic results, and all supported SERP
features — never raw provider JSON, never provider-specific UI models.

**Why this priority**: The frozen contract is hard gate G4: no enrichment UI or provider work in later
packages may begin until this contract exists.

**Independent Test**: Can be tested by statically verifying that UI and detector code import only the
normalized contract types and that a fixture SERP snapshot validates against the frozen schema.

**Acceptance Scenarios**:

1. **Given** the frozen contract, **When** enrichment and features UI are later implemented,
   **Then** they consume normalized snapshots only; no component parses raw provider payloads.
2. **Given** a provider omits a feature (e.g., no shopping block), **When** the snapshot is built,
   **Then** the feature is absent (not fabricated, not null-coerced to empty claims).

---

### User Story 3 - Keep provider metrics honestly labeled (Priority: P3)

Anyone reading enriched SERP data sees provider-accurate metric names (DataForSEO Domain Rank / Page
Rank, referring domains, backlinks, provider-supported spam/risk, estimated traffic only where genuinely
available) — never fake DA, PA, DR, TF, or CF labels.

**Why this priority**: Metric honesty is a constitutional rule; freezing the naming convention in the
contract prevents mislabeling downstream.

**Independent Test**: Can be tested by reviewing the contract's metric vocabulary against provider
documentation and confirming no proprietary third-party metric names appear.

**Acceptance Scenarios**:

1. **Given** the frozen contract's metric vocabulary, **When** reviewed against provider docs,
   **Then** every metric name maps to a genuinely available provider field, and no DA/PA/DR/TF/CF
   labels exist.

---

### Edge Cases

- What happens when providers disagree on result sets for the same keyword? The contract records provider
  identity and check time per snapshot; reconciliation policy (if any) is a later package's decision, not
  this contract's.
- How are check-time vs provider-snapshot-time distinguished? Both timestamps are first-class fields with
  distinct meanings; freshness is never inferred from fetch time alone.
- What happens when a provider returns extra fields not in the contract? They are ignored by the normalized
  model (available via trace/debug, not via the contract).
- How are PAA ordering semantics handled when the provider gives no reliable placement? The contract
  carries observed items plus optional placement metadata; rendering policy is decided in the features UI
  package.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The discovery report MUST document the actual end-to-end SERP path (entry points, resolver,
  provider adapters and order, normalization, cache, request coalescing, cost tracking, trace) with
  references to live code files.
- **FR-002**: The frozen contract MUST cover snapshot context and organic results. The logical snapshot
  identity MUST be (keyword, engine, canonical location, language, device, checkedAt): each dimension
  canonicalized before key construction (canonical keyword, normalized engine id, canonical
  locationCode/location identity, canonical language code, normalized device enum, full ISO observation
  timestamp — never calendar date alone, so multiple same-day checks cannot collide). Provider and
  provider status are provenance fields, NOT identity. A content hash may be stored separately for
  integrity/dedup/validation but MUST NOT replace the logical identity. Where snapshot storage is
  project-owned, projectId joins the storage key as tenancy scoping, not as observation semantics.
- **FR-003**: The frozen contract MUST cover all supported SERP feature families: featured result, People
  Also Ask, related searches, local pack, images, videos, shopping, news, knowledge graph, sitelinks.
- **FR-004**: Downstream consumers MUST use the normalized contract only. Raw provider JSON MUST NOT be
  parsed in UI or detector code, and no second SERP resolver or provider-specific UI model may be created.
- **FR-005**: The contract's metric vocabulary MUST use provider-accurate names only. Proprietary
  third-party metric labels (DA, PA, DR, TF, CF) are prohibited.
- **FR-006**: The contract MUST distinguish provider-snapshot time from OpenSEO fetch time as separate fields.
- **FR-007**: Absent provider features MUST be represented as absent, never fabricated or defaulted.

### Key Entities

- **SerpSnapshot**: One normalized keyword SERP observation; attributes include market context, check
  timestamps, organic results, feature blocks, and provider provenance.
- **SerpOrganicResult**: One normalized organic listing; attributes include position, title, URL, domain,
  result type, and associated-feature references.
- **SerpFeatureSet**: The normalized feature blocks (PAA items, featured result, local pack, media,
  shopping, news, knowledge graph, sitelinks, related searches), each present only when observed.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An engineer unfamiliar with the SERP code can trace one keyword end-to-end using only the
  discovery report, with zero corrections needed from the report's file references.
- **SC-002**: Hard gate G4 is recorded as satisfied: the frozen contract is checked in, reviewed, and
  referenced as the mandatory input by the enrichment and features-UI packages.
- **SC-003**: A review of all SERP UI/detector code finds zero raw-provider parsing and zero
  provider-specific UI models.
- **SC-004**: A fixture snapshot missing half the feature families validates cleanly, with absent features
  represented as absent (no fabrication, no validation errors).

## Assumptions

- No enrichment implementation, no new provider calls, and no UI changes belong in this package —
  discovery plus contract freeze only.
- The exact field shapes follow existing repository type conventions; planning adapts the conceptual model
  to house style without changing its semantics.
- Cache dimensions, bulk strategy, and merge identity are decided in the Top-10 enrichment package (007)
  against this frozen contract.
- Existing R2/cache, single-flight, budget-guard, and trace primitives are reused; this package only
  documents how the SERP path uses them.
