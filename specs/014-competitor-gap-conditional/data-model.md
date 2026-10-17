# Data Model: Competitor-Gap Conditional

D1/SQLite and PostgreSQL parity is mandatory (P3). All tables additive, project/org-scoped, parity-tested per existing migration conventions.

## Entity: competitor_gap_verdicts (new — Part A, unconditional)

Append-only durable ledger for spike verdicts. Authoritative gate for Part B/C availability (P42).

| Field          | Type        | Notes                                                                                        |
| -------------- | ----------- | -------------------------------------------------------------------------------------------- |
| id             | text (PK)   | deterministic id from manifest hash + recordedAt                                             |
| organizationId | text (FK)   | org scope                                                                                    |
| projectId      | text (FK)   | project scope (P39)                                                                          |
| verdict        | text        | enum: `COMPETITOR_GAP_READY` \| `COMPETITOR_GAP_BLOCKED` (FR-002)                            |
| evidence       | text (JSON) | frozen measurements: 5 dimensions per research R3 (quality, coverage, cost, identity, cache) |
| thresholds     | text (JSON) | the pre-registered threshold set evaluated (R4)                                              |
| inputManifest  | text (JSON) | spike config: sampled domains, keyword-set ref, market, budget cap, time box                 |
| recordedAt     | text (ISO)  | immutable append timestamp                                                                   |

- Indexes: `(organizationId, projectId, recordedAt desc)` for latest-verdict reads.
- No updates/deletes by product code paths; supersession = new row (FR-003).
- Latest READY verdict per project = gate value consulted by detection stage and workflow allowlist.

## Entity: competitor reference (no new entity — reuse)

Competitor domains come from existing surfaces: `competitor_snapshots` rows (persisted per project + keyword set + market) and project competitor configuration used by `find_serp_competitors` / Share-of-Voice (`ai-search.ts` schemas). Identity via the `canonicalUrl()` / §006 chain; no parallel canonicalization (§2.1, P24).

## Entity: competitor gap finding → opportunity (conditional, Part B)

Uses existing `findings` / `opportunities` schema (`src/db/opportunities.schema.ts`, `intelligence.schema.ts`) with standard fields; this package adds no columns. Conventions:

- `detectorKey`: `"competitor_gap"` (registered in detector registry, versioned)
- `findingKey`: deterministic from `(detectorKey, detectorVersion, entityKey, periodFrom, periodTo)`
- `entityKey`: canonical identity of the comparison scope (project market + keyword-set key)
- evidence.metrics: observed competitor positions, user-site absence/weakness signals, coverage flags
- evidence.provenance: `THIRD_PARTY_ESTIMATE` / `SERP_OBSERVED` classification (P47)
- `impactScore` / `confidenceScore` separate (P26); `evidenceType: "observational"` (P27/P46)
- Idempotent materialization: re-scan upserts by `findingKey`; zero duplicates (SC-004)

## Entity: autopilot run for `competitor_gap` (conditional, Part C)

Reuses existing `autopilot_runs` / step ledger (`autopilot.schema.ts`), with `workflowType: "competitor_gap"` added to `AUTOPILOT_WORKFLOW_TYPES` only in the READY PR (existing structural-exclusion test updated in same PR per R5). Frozen `sourceEvidenceRef` points at findings snapshot; budgets and step ledger per existing infrastructure.

## State transitions

- `competitor_gap_verdicts`: none — append-only immutable rows.
- Detection availability per project: `NO_VERDICT | BLOCKED | READY` derived from latest verdict row; transitions only via new spike records.
- Opportunity lifecycle: standard `open → in_progress → completed|dismissed` (unchanged).
